"""
azure_client.py

Azure Blob Storage client implementation for the deepfreeze package.
Maps S3 concepts to Azure equivalents:
- S3 Bucket -> Azure Blob Container
- S3 Object -> Azure Blob
- Glacier/Deep Archive -> Azure Archive tier
- S3 restore -> Azure blob rehydration
"""

import logging
import os

from azure.core.exceptions import (
    AzureError,
    ResourceExistsError,
    ResourceNotFoundError,
)
from azure.storage.blob import BlobServiceClient, StandardBlobTier

from deepfreeze_core.exceptions import ActionError
from deepfreeze_core.s3client import S3Client


class AzureBlobClient(S3Client):
    """
    Azure Blob Storage client implementing the S3Client interface.
    """

    def __init__(self) -> None:
        self.loggit = logging.getLogger("deepfreeze.azure_client")
        try:
            # Azure SDK uses connection string from environment variable
            # AZURE_STORAGE_CONNECTION_STRING or account name + key
            connection_string = os.environ.get("AZURE_STORAGE_CONNECTION_STRING")
            if connection_string:
                self.service_client = BlobServiceClient.from_connection_string(
                    connection_string
                )
                self.loggit.debug("Using AZURE_STORAGE_CONNECTION_STRING for auth")
            else:
                # Alternative: account name + key
                account_name = os.environ.get("AZURE_STORAGE_ACCOUNT")
                account_key = os.environ.get("AZURE_STORAGE_KEY")
                if account_name and account_key:
                    account_url = f"https://{account_name}.blob.core.windows.net"
                    self.service_client = BlobServiceClient(
                        account_url=account_url, credential=account_key
                    )
                    self.loggit.debug(
                        "Using AZURE_STORAGE_ACCOUNT + AZURE_STORAGE_KEY for auth"
                    )
                else:
                    raise ActionError(
                        "Azure credentials not configured. Set AZURE_STORAGE_CONNECTION_STRING "
                        "or both AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_KEY."
                    )

            # Validate credentials
            self.loggit.debug("Validating Azure credentials")
            list(self.service_client.list_containers(max_results=1))
            self.loggit.info("Azure Blob Storage Client initialized successfully")

        except AzureError as e:
            self.loggit.error("Failed to initialize Azure Blob Storage Client: %s", e)
            raise ActionError(
                f"Failed to initialize Azure Blob Storage Client: {e}"
            ) from e
        except Exception as e:
            self.loggit.error(
                "Failed to initialize Azure Blob Storage Client: %s", e, exc_info=True
            )
            raise ActionError(
                f"Failed to initialize Azure Blob Storage Client: {e}"
            ) from e

    def test_connection(self) -> bool:
        """
        Test Azure connection and validate credentials.

        :return: True if credentials are valid and Azure is accessible
        :rtype: bool
        """
        try:
            self.loggit.debug("Testing Azure connection")
            list(self.service_client.list_containers(max_results=1))
            return True
        except AzureError as e:
            self.loggit.error("Azure connection test failed: %s", e)
            return False

    def create_bucket(self, bucket_name: str) -> None:
        """Create an Azure Blob container (equivalent to S3 bucket)."""
        self.loggit.info(f"Creating container: {bucket_name}")
        if self.bucket_exists(bucket_name):
            self.loggit.info(f"Container {bucket_name} already exists")
            raise ActionError(f"Container {bucket_name} already exists")
        try:
            self.service_client.create_container(bucket_name)
            self.loggit.info(f"Successfully created container {bucket_name}")
        except ResourceExistsError as e:
            raise ActionError(f"Container {bucket_name} already exists") from e
        except AzureError as e:
            self.loggit.error(f"Error creating container {bucket_name}: {e}")
            raise ActionError(f"Error creating container {bucket_name}: {e}") from e

    def bucket_exists(self, bucket_name: str) -> bool:
        """Check if an Azure Blob container exists."""
        self.loggit.debug(f"Checking if container {bucket_name} exists")
        try:
            container_client = self.service_client.get_container_client(bucket_name)
            container_client.get_container_properties()
            self.loggit.debug(f"Container {bucket_name} exists")
            return True
        except ResourceNotFoundError:
            self.loggit.debug(f"Container {bucket_name} does not exist")
            return False
        except AzureError as e:
            self.loggit.error(
                "Error checking container existence for %s: %s", bucket_name, e
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
        Rehydrate blobs from Archive tier.

        Azure rehydration is different from S3 Glacier restore:
        - Uses set_standard_blob_tier() with rehydrate_priority
        - Tier options: 'Hot', 'Cool' (Archive cannot be read directly)
        - Rehydrate priorities: 'Standard' (up to 15 hours), 'High' (under 1 hour)
        - Note: restore_days is not used in Azure - rehydration changes the tier permanently

        Args:
            bucket_name (str): The name of the container
            base_path (str): The base path (prefix) of the blobs to thaw
            object_keys (list[dict]): A list of blob metadata dictionaries
            restore_days (int): Not used in Azure (kept for interface compatibility)
            retrieval_tier (str): 'Standard', 'Bulk', or 'Expedited' (mapped to Azure priorities)

        Returns:
            None
        """
        self.loggit.info(
            "Starting thaw operation - container: %s, base_path: %s, objects: %d, tier: %s",
            bucket_name,
            base_path,
            len(object_keys),
            retrieval_tier,
        )

        # Map S3 retrieval tier to Azure rehydrate priority
        priority_map = {
            "Standard": "Standard",
            "Bulk": "Standard",  # Azure doesn't have Bulk, use Standard
            "Expedited": "High",
        }
        rehydrate_priority = priority_map.get(retrieval_tier, "Standard")

        container_client = self.service_client.get_container_client(bucket_name)
        restored_count = 0
        skipped_count = 0
        error_count = 0

        for idx, obj in enumerate(object_keys, 1):
            key = obj.get("Key") if isinstance(obj, dict) else obj

            if not key.startswith(base_path):
                skipped_count += 1
                continue

            try:
                blob_client = container_client.get_blob_client(key)
                properties = blob_client.get_blob_properties()
                current_tier = properties.blob_tier

                if current_tier == "Archive":
                    self.loggit.debug(
                        "Rehydrating blob %d/%d: %s from Archive (priority: %s)",
                        idx,
                        len(object_keys),
                        key,
                        rehydrate_priority,
                    )
                    # Rehydrate to Hot tier
                    blob_client.set_standard_blob_tier(
                        StandardBlobTier.HOT, rehydrate_priority=rehydrate_priority
                    )
                    restored_count += 1
                else:
                    self.loggit.debug(
                        "Skipping blob %d/%d: %s (tier: %s, not Archive)",
                        idx,
                        len(object_keys),
                        key,
                        current_tier,
                    )
                    skipped_count += 1

            except AzureError as e:
                error_count += 1
                self.loggit.error(
                    "Error rehydrating blob %d/%d (%s): %s (type: %s)",
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
        Move blobs back to Archive tier.

        Maps S3 storage classes to Azure tiers:
        - GLACIER -> Archive
        - DEEP_ARCHIVE -> Archive (Azure has only one archive tier)
        - GLACIER_IR -> Cool (closest equivalent)

        Args:
            bucket_name (str): The name of the container
            path (str): The path (prefix) to the blobs to refreeze
            storage_class (str): The S3-style storage class to move blobs to

        Returns:
            None
        """
        self.loggit.info(
            "Starting refreeze operation - container: %s, path: %s, target_storage_class: %s",
            bucket_name,
            path,
            storage_class,
        )

        # Map S3 storage class to Azure tier
        tier_map = {
            "GLACIER": StandardBlobTier.ARCHIVE,
            "DEEP_ARCHIVE": StandardBlobTier.ARCHIVE,
            "GLACIER_IR": StandardBlobTier.COOL,
        }
        target_tier = tier_map.get(storage_class, StandardBlobTier.ARCHIVE)

        container_client = self.service_client.get_container_client(bucket_name)
        refrozen_count = 0
        error_count = 0

        # List blobs with prefix
        blobs = container_client.list_blobs(name_starts_with=path)

        for blob in blobs:
            try:
                blob_client = container_client.get_blob_client(blob.name)
                current_tier = blob.blob_tier
                self.loggit.debug(
                    "Refreezing blob: %s (from %s to %s)",
                    blob.name,
                    current_tier,
                    target_tier,
                )
                blob_client.set_standard_blob_tier(target_tier)
                refrozen_count += 1
            except AzureError as e:
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
        List blobs in a container with a given prefix.

        Args:
            bucket_name (str): The name of the container to list blobs from.
            prefix (str): The prefix to use when listing blobs.

        Returns:
            list[dict]: A list of blob metadata dictionaries with S3-compatible keys.
        """
        self.loggit.info(
            f"Listing blobs in container: {bucket_name} with prefix: {prefix}"
        )

        container_client = self.service_client.get_container_client(bucket_name)
        objects = []

        try:
            blobs = container_client.list_blobs(name_starts_with=prefix)
            for blob in blobs:
                # Map Azure properties to S3-like structure for compatibility
                objects.append(
                    {
                        "Key": blob.name,
                        "Size": blob.size,
                        "LastModified": blob.last_modified,
                        "StorageClass": self._map_azure_tier_to_s3(blob.blob_tier),
                        # Azure-specific
                        "BlobTier": blob.blob_tier,
                        "ArchiveStatus": getattr(blob, "archive_status", None),
                    }
                )
            return objects
        except AzureError as e:
            self.loggit.error("Error listing blobs: %s", e)
            raise ActionError(f"Error listing blobs: {e}") from e

    def delete_bucket(self, bucket_name: str, force: bool = False) -> None:
        """
        Delete an Azure Blob container.

        Args:
            bucket_name (str): The name of the container to delete.
            force (bool): If True, empty the container before deleting it.

        Returns:
            None
        """
        self.loggit.info(f"Deleting container: {bucket_name}")
        try:
            container_client = self.service_client.get_container_client(bucket_name)

            if force:
                self.loggit.info(f"Emptying container {bucket_name} before deletion")
                blobs = container_client.list_blobs()
                for blob in blobs:
                    container_client.delete_blob(blob.name)
                    self.loggit.debug(f"Deleted blob {blob.name}")

            container_client.delete_container()
            self.loggit.info(f"Container {bucket_name} deleted successfully")
        except AzureError as e:
            self.loggit.error(e)
            raise ActionError(e) from e

    def put_object(self, bucket_name: str, key: str, body: str = "") -> None:
        """
        Upload a blob to a container.

        Args:
            bucket_name (str): The name of the container to put the blob in.
            key (str): The key of the blob to put.
            body (str): The body of the blob to put.

        Returns:
            None
        """
        self.loggit.info(f"Putting blob: {key} in container: {bucket_name}")
        try:
            container_client = self.service_client.get_container_client(bucket_name)
            blob_client = container_client.get_blob_client(key)
            blob_client.upload_blob(body, overwrite=True)
        except AzureError as e:
            self.loggit.error(e)
            raise ActionError(e) from e

    def list_buckets(self, prefix: str = None) -> list[str]:
        """
        List all containers.

        Args:
            prefix (str): Optional prefix to filter container names.

        Returns:
            list[str]: A list of container names.
        """
        self.loggit.info("Listing containers")
        try:
            containers = self.service_client.list_containers()
            container_names = [c.name for c in containers]
            if prefix:
                container_names = [
                    name for name in container_names if name.startswith(prefix)
                ]
            return container_names
        except AzureError as e:
            self.loggit.error(e)
            raise ActionError(e) from e

    def head_object(self, bucket_name: str, key: str) -> dict:
        """
        Retrieve metadata for a blob without downloading it.

        Args:
            bucket_name (str): The name of the container.
            key (str): The blob key.

        Returns:
            dict: Blob metadata including Restore status if applicable.
        """
        self.loggit.debug(f"Getting metadata for azure://{bucket_name}/{key}")
        try:
            container_client = self.service_client.get_container_client(bucket_name)
            blob_client = container_client.get_blob_client(key)
            properties = blob_client.get_blob_properties()

            # Map to S3-like response structure
            response = {
                "ContentLength": properties.size,
                "ContentType": properties.content_settings.content_type,
                "LastModified": properties.last_modified,
                "ETag": properties.etag,
                "StorageClass": self._map_azure_tier_to_s3(properties.blob_tier),
                # Azure rehydration status maps to S3 Restore header
                "Restore": self._format_restore_header(properties),
                # Azure-specific
                "BlobTier": properties.blob_tier,
                "ArchiveStatus": getattr(properties, "archive_status", None),
            }
            return response
        except ResourceNotFoundError as e:
            self.loggit.error(f"Blob not found: {key}")
            raise ActionError(f"Blob not found: {key}") from e
        except AzureError as e:
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
        Copy a blob with storage class change.

        Args:
            Bucket (str): The name of the destination container.
            Key (str): The key for the copied blob.
            CopySource (dict[str, str]): The source container and key.
            StorageClass (str): The S3-style storage class to use.

        Returns:
            None
        """
        self.loggit.info(f"Copying blob {Key} to container {Bucket}")
        try:
            source_container = CopySource["Bucket"]
            source_key = CopySource["Key"]

            # Get source URL
            source_container_client = self.service_client.get_container_client(
                source_container
            )
            source_blob_client = source_container_client.get_blob_client(source_key)
            source_url = source_blob_client.url

            # Copy to destination
            dest_container_client = self.service_client.get_container_client(Bucket)
            dest_blob_client = dest_container_client.get_blob_client(Key)

            # Start copy operation
            dest_blob_client.start_copy_from_url(source_url)

            # Set storage tier
            tier_map = {
                "GLACIER": StandardBlobTier.ARCHIVE,
                "DEEP_ARCHIVE": StandardBlobTier.ARCHIVE,
                "STANDARD": StandardBlobTier.HOT,
                "STANDARD_IA": StandardBlobTier.COOL,
            }
            target_tier = tier_map.get(StorageClass, StandardBlobTier.ARCHIVE)
            dest_blob_client.set_standard_blob_tier(target_tier)

        except AzureError as e:
            self.loggit.error(e)
            raise ActionError(e) from e

    def _map_azure_tier_to_s3(self, azure_tier: str) -> str:
        """
        Map Azure blob tier to S3 storage class for compatibility.

        Args:
            azure_tier (str): The Azure blob tier.

        Returns:
            str: The equivalent S3 storage class.
        """
        tier_map = {
            "Hot": "STANDARD",
            "Cool": "STANDARD_IA",
            "Cold": "ONEZONE_IA",
            "Archive": "GLACIER",
        }
        return tier_map.get(azure_tier, "STANDARD")

    def _format_restore_header(self, properties) -> str:
        """
        Format Azure rehydration status to S3-like Restore header.

        Args:
            properties: The blob properties object.

        Returns:
            str: S3-style restore header or None.
        """
        archive_status = getattr(properties, "archive_status", None)
        blob_tier = properties.blob_tier

        if blob_tier == "Archive":
            if archive_status in [
                "rehydrate-pending-to-hot",
                "rehydrate-pending-to-cool",
            ]:
                return 'ongoing-request="true"'
            return None  # Not restored
        elif blob_tier in ("Hot", "Cool") and archive_status:
            # Was rehydrated from archive
            return 'ongoing-request="false"'
        return None
