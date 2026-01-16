"""
gcp_client.py

Google Cloud Storage client implementation for the deepfreeze package.
Maps S3 concepts to GCP equivalents:
- S3 Bucket -> GCS Bucket
- S3 Object -> GCS Blob
- Glacier/Deep Archive -> GCS Archive storage class
- Storage classes: STANDARD, NEARLINE, COLDLINE, ARCHIVE
"""

import logging
import os

from google.api_core.exceptions import Conflict, GoogleAPIError, NotFound
from google.cloud import storage

from deepfreeze_core.exceptions import ActionError
from deepfreeze_core.s3client import S3Client


class GcpStorageClient(S3Client):
    """
    Google Cloud Storage client implementing the S3Client interface.

    Credentials can be provided via constructor arguments or environment variables.
    Constructor arguments take precedence over environment variables.

    Args:
        project: GCP project ID
        credentials_file: Path to service account JSON credentials file
        location: Default location for bucket creation (default: US)

    Environment variables (fallback):
        GOOGLE_CLOUD_PROJECT: Project ID
        GOOGLE_APPLICATION_CREDENTIALS: Path to credentials file
        GOOGLE_CLOUD_LOCATION: Default location for buckets
    """

    def __init__(
        self,
        project: str = None,
        credentials_file: str = None,
        location: str = None,
    ) -> None:
        self.loggit = logging.getLogger("deepfreeze.gcp_client")
        self.default_location = location or os.environ.get("GOOGLE_CLOUD_LOCATION", "US")

        try:
            # Priority: constructor args > environment variables
            project_id = project or os.environ.get("GOOGLE_CLOUD_PROJECT")
            creds_file = credentials_file or os.environ.get(
                "GOOGLE_APPLICATION_CREDENTIALS"
            )

            if creds_file:
                # Use explicit credentials file
                self.client = storage.Client.from_service_account_json(
                    creds_file, project=project_id
                )
                self.loggit.debug(
                    "Using credentials file: %s (source: %s)",
                    creds_file,
                    "config" if credentials_file else "environment",
                )
            elif project_id:
                # Use ADC with explicit project
                self.client = storage.Client(project=project_id)
                self.loggit.debug(
                    "Using project %s with ADC (source: %s)",
                    project_id,
                    "config" if project else "environment",
                )
            else:
                # Use default ADC
                self.client = storage.Client()
                self.loggit.debug("Using default Application Default Credentials")

            # Validate credentials by listing buckets (limited to 1)
            self.loggit.debug("Validating GCP credentials")
            list(self.client.list_buckets(max_results=1))
            self.loggit.info("GCP Storage Client initialized successfully")

        except GoogleAPIError as e:
            self.loggit.error("Failed to initialize GCP Storage Client: %s", e)
            raise ActionError(
                f"Failed to initialize GCP Storage Client: {e}"
            ) from e
        except Exception as e:
            self.loggit.error(
                "Failed to initialize GCP Storage Client: %s", e, exc_info=True
            )
            raise ActionError(
                f"Failed to initialize GCP Storage Client: {e}"
            ) from e

    def test_connection(self) -> bool:
        """
        Test GCP connection and validate credentials.

        :return: True if credentials are valid and GCS is accessible
        :rtype: bool
        """
        try:
            self.loggit.debug("Testing GCP connection")
            list(self.client.list_buckets(max_results=1))
            return True
        except GoogleAPIError as e:
            self.loggit.error("GCP connection test failed: %s", e)
            return False

    def create_bucket(self, bucket_name: str) -> None:
        """Create a GCS bucket."""
        self.loggit.info(f"Creating bucket: {bucket_name}")
        if self.bucket_exists(bucket_name):
            self.loggit.info(f"Bucket {bucket_name} already exists")
            raise ActionError(f"Bucket {bucket_name} already exists")
        try:
            bucket = self.client.bucket(bucket_name)
            self.client.create_bucket(bucket, location=self.default_location)
            self.loggit.info(
                f"Successfully created bucket {bucket_name} in location {self.default_location}"
            )
        except Conflict as e:
            raise ActionError(f"Bucket {bucket_name} already exists") from e
        except GoogleAPIError as e:
            self.loggit.error(f"Error creating bucket {bucket_name}: {e}")
            raise ActionError(f"Error creating bucket {bucket_name}: {e}") from e

    def bucket_exists(self, bucket_name: str) -> bool:
        """Check if a GCS bucket exists."""
        self.loggit.debug(f"Checking if bucket {bucket_name} exists")
        try:
            bucket = self.client.bucket(bucket_name)
            bucket.reload()
            self.loggit.debug(f"Bucket {bucket_name} exists")
            return True
        except NotFound:
            self.loggit.debug(f"Bucket {bucket_name} does not exist")
            return False
        except GoogleAPIError as e:
            self.loggit.error(
                "Error checking bucket existence for %s: %s", bucket_name, e
            )
            raise ActionError(e) from e

    def thaw(
        self,
        bucket_name: str,
        base_path: str,
        object_keys: list[dict],
        restore_days: int = 7,
        retrieval_tier: str = "Standard",
    ) -> None:
        """
        Move objects from Archive/Coldline to Standard storage class.

        Unlike AWS Glacier, GCS Archive objects are immediately accessible,
        just with higher retrieval costs. "Thawing" means changing the
        storage class to STANDARD for faster/cheaper access.

        Args:
            bucket_name (str): The name of the bucket
            base_path (str): The base path (prefix) of the objects to thaw
            object_keys (list[dict]): A list of object metadata dictionaries
            restore_days (int): Not used in GCP (kept for interface compatibility)
            retrieval_tier (str): Not used in GCP (kept for interface compatibility)

        Returns:
            None
        """
        self.loggit.info(
            "Starting thaw operation - bucket: %s, base_path: %s, objects: %d",
            bucket_name,
            base_path,
            len(object_keys),
        )

        bucket = self.client.bucket(bucket_name)
        restored_count = 0
        skipped_count = 0
        error_count = 0

        for idx, obj in enumerate(object_keys, 1):
            key = obj.get("Key") if isinstance(obj, dict) else obj

            if not key.startswith(base_path):
                skipped_count += 1
                continue

            try:
                blob = bucket.blob(key)
                blob.reload()
                current_class = blob.storage_class

                if current_class in ["ARCHIVE", "COLDLINE", "NEARLINE"]:
                    self.loggit.debug(
                        "Thawing blob %d/%d: %s from %s to STANDARD",
                        idx,
                        len(object_keys),
                        key,
                        current_class,
                    )
                    blob.update_storage_class("STANDARD")
                    restored_count += 1
                else:
                    self.loggit.debug(
                        "Skipping blob %d/%d: %s (storage class: %s)",
                        idx,
                        len(object_keys),
                        key,
                        current_class,
                    )
                    skipped_count += 1

            except GoogleAPIError as e:
                error_count += 1
                self.loggit.error(
                    "Error thawing blob %d/%d (%s): %s (type: %s)",
                    idx,
                    len(object_keys),
                    key,
                    str(e),
                    type(e).__name__,
                )

        self.loggit.info(
            "Thaw operation completed - restored: %d, skipped: %d, errors: %d (total: %d)",
            restored_count,
            skipped_count,
            error_count,
            len(object_keys),
        )

    def refreeze(
        self, bucket_name: str, path: str, storage_class: str = "GLACIER"
    ) -> None:
        """
        Move objects to Archive storage class.

        Maps S3 storage classes to GCS:
        - GLACIER -> ARCHIVE
        - DEEP_ARCHIVE -> ARCHIVE
        - GLACIER_IR -> COLDLINE

        Args:
            bucket_name (str): The name of the bucket
            path (str): The path (prefix) to the objects to refreeze
            storage_class (str): The S3-style storage class to move objects to

        Returns:
            None
        """
        self.loggit.info(
            "Starting refreeze operation - bucket: %s, path: %s, target_storage_class: %s",
            bucket_name,
            path,
            storage_class,
        )

        # Map S3 storage class to GCS storage class
        class_map = {
            "GLACIER": "ARCHIVE",
            "DEEP_ARCHIVE": "ARCHIVE",
            "GLACIER_IR": "COLDLINE",
        }
        target_class = class_map.get(storage_class, "ARCHIVE")

        bucket = self.client.bucket(bucket_name)
        refrozen_count = 0
        error_count = 0

        # List blobs with prefix
        blobs = bucket.list_blobs(prefix=path)

        for blob in blobs:
            try:
                current_class = blob.storage_class
                self.loggit.debug(
                    "Refreezing blob: %s (from %s to %s)",
                    blob.name,
                    current_class,
                    target_class,
                )
                blob.update_storage_class(target_class)
                refrozen_count += 1
            except GoogleAPIError as e:
                error_count += 1
                self.loggit.error(
                    "Error refreezing blob %s: %s (type: %s)",
                    blob.name,
                    str(e),
                    type(e).__name__,
                    exc_info=True,
                )

        self.loggit.info(
            "Refreeze operation completed - refrozen: %d, errors: %d",
            refrozen_count,
            error_count,
        )

    def list_objects(self, bucket_name: str, prefix: str) -> list[dict]:
        """
        List objects in a bucket with a given prefix.

        Args:
            bucket_name (str): The name of the bucket to list objects from.
            prefix (str): The prefix to use when listing objects.

        Returns:
            list[dict]: A list of object metadata dictionaries with S3-compatible keys.
        """
        self.loggit.info(
            f"Listing objects in bucket: {bucket_name} with prefix: {prefix}"
        )

        bucket = self.client.bucket(bucket_name)
        objects = []

        try:
            blobs = bucket.list_blobs(prefix=prefix)
            for blob in blobs:
                # Map GCS properties to S3-like structure for compatibility
                objects.append(
                    {
                        "Key": blob.name,
                        "Size": blob.size,
                        "LastModified": blob.updated,
                        "StorageClass": self._map_gcs_class_to_s3(blob.storage_class),
                        # GCS-specific
                        "GcsStorageClass": blob.storage_class,
                    }
                )
            return objects
        except GoogleAPIError as e:
            self.loggit.error("Error listing objects: %s", e)
            raise ActionError(f"Error listing objects: {e}") from e

    def delete_bucket(self, bucket_name: str, force: bool = False) -> None:
        """
        Delete a GCS bucket.

        Args:
            bucket_name (str): The name of the bucket to delete.
            force (bool): If True, empty the bucket before deleting it.

        Returns:
            None
        """
        self.loggit.info(f"Deleting bucket: {bucket_name}")
        try:
            bucket = self.client.bucket(bucket_name)

            if force:
                self.loggit.info(f"Emptying bucket {bucket_name} before deletion")
                blobs = bucket.list_blobs()
                for blob in blobs:
                    blob.delete()
                    self.loggit.debug(f"Deleted blob {blob.name}")

            bucket.delete()
            self.loggit.info(f"Bucket {bucket_name} deleted successfully")
        except GoogleAPIError as e:
            self.loggit.error(e)
            raise ActionError(e) from e

    def put_object(self, bucket_name: str, key: str, body: str = "") -> None:
        """
        Upload an object to a bucket.

        Args:
            bucket_name (str): The name of the bucket to put the object in.
            key (str): The key of the object to put.
            body (str): The body of the object to put.

        Returns:
            None
        """
        self.loggit.info(f"Putting object: {key} in bucket: {bucket_name}")
        try:
            bucket = self.client.bucket(bucket_name)
            blob = bucket.blob(key)
            blob.upload_from_string(body)
        except GoogleAPIError as e:
            self.loggit.error(e)
            raise ActionError(e) from e

    def list_buckets(self, prefix: str = None) -> list[str]:
        """
        List all buckets.

        Args:
            prefix (str): Optional prefix to filter bucket names.

        Returns:
            list[str]: A list of bucket names.
        """
        self.loggit.info("Listing buckets")
        try:
            buckets = self.client.list_buckets()
            bucket_names = [b.name for b in buckets]
            if prefix:
                bucket_names = [
                    name for name in bucket_names if name.startswith(prefix)
                ]
            return bucket_names
        except GoogleAPIError as e:
            self.loggit.error(e)
            raise ActionError(e) from e

    def head_object(self, bucket_name: str, key: str) -> dict:
        """
        Retrieve metadata for an object without downloading it.

        Args:
            bucket_name (str): The name of the bucket.
            key (str): The object key.

        Returns:
            dict: Object metadata including storage class.
        """
        self.loggit.debug(f"Getting metadata for gs://{bucket_name}/{key}")
        try:
            bucket = self.client.bucket(bucket_name)
            blob = bucket.blob(key)
            blob.reload()

            # Map to S3-like response structure
            response = {
                "ContentLength": blob.size,
                "ContentType": blob.content_type,
                "LastModified": blob.updated,
                "ETag": blob.etag,
                "StorageClass": self._map_gcs_class_to_s3(blob.storage_class),
                # GCS doesn't have restore concept like S3 Glacier
                # Archive objects are immediately accessible
                "Restore": None,
                # GCS-specific
                "GcsStorageClass": blob.storage_class,
            }
            return response
        except NotFound as e:
            self.loggit.error(f"Object not found: {key}")
            raise ActionError(f"Object not found: {key}") from e
        except GoogleAPIError as e:
            self.loggit.error(f"Error getting metadata for {key}: {e}")
            raise ActionError(f"Error getting metadata for {key}: {e}") from e

    def copy_object(
        self,
        Bucket: str,
        Key: str,
        CopySource: dict[str, str],
        StorageClass: str = "GLACIER",
    ) -> None:
        """
        Copy an object with storage class change.

        Args:
            Bucket (str): The name of the destination bucket.
            Key (str): The key for the copied object.
            CopySource (dict[str, str]): The source bucket and key.
            StorageClass (str): The S3-style storage class to use.

        Returns:
            None
        """
        self.loggit.info(f"Copying object {Key} to bucket {Bucket}")
        try:
            source_bucket_name = CopySource["Bucket"]
            source_key = CopySource["Key"]

            # Map S3 storage class to GCS
            class_map = {
                "GLACIER": "ARCHIVE",
                "DEEP_ARCHIVE": "ARCHIVE",
                "STANDARD": "STANDARD",
                "STANDARD_IA": "NEARLINE",
            }
            target_class = class_map.get(StorageClass, "ARCHIVE")

            source_bucket = self.client.bucket(source_bucket_name)
            source_blob = source_bucket.blob(source_key)

            dest_bucket = self.client.bucket(Bucket)
            dest_blob = dest_bucket.blob(Key)

            # Copy the blob
            token = None
            while True:
                token, _, _ = dest_blob.rewrite(source_blob, token=token)
                if token is None:
                    break

            # Update storage class if different from default
            if target_class != "STANDARD":
                dest_blob.update_storage_class(target_class)

        except GoogleAPIError as e:
            self.loggit.error(e)
            raise ActionError(e) from e

    def _map_gcs_class_to_s3(self, gcs_class: str) -> str:
        """
        Map GCS storage class to S3 storage class for compatibility.

        Args:
            gcs_class (str): The GCS storage class.

        Returns:
            str: The equivalent S3 storage class.
        """
        class_map = {
            "STANDARD": "STANDARD",
            "NEARLINE": "STANDARD_IA",
            "COLDLINE": "ONEZONE_IA",
            "ARCHIVE": "GLACIER",
        }
        return class_map.get(gcs_class, "STANDARD")
