"""
s3client.py

S3 client abstraction for the standalone deepfreeze package.
Provides a unified interface for S3 operations across different cloud providers.
"""

import abc


class S3Client(metaclass=abc.ABCMeta):
    """
    Superclass for S3 Clients.

    This class should *only* perform actions that are common to all S3 clients. It
    should not handle record-keeping or anything unrelated to S3 actions. The calling
    methods should handle that.
    """

    @abc.abstractmethod
    def create_bucket(self, bucket_name: str) -> None:
        """
        Create a bucket with the given name.

        Args:
            bucket_name (str): The name of the bucket to create.

        Returns:
            None
        """
        return

    @abc.abstractmethod
    def test_connection(self) -> bool:
        """
        Test S3 connection and validate credentials.

        :return: True if credentials are valid and S3 is accessible
        :rtype: bool
        """
        return

    @abc.abstractmethod
    def bucket_exists(self, bucket_name: str) -> bool:
        """
        Test whether or not the named bucket exists

        :param bucket_name: Bucket name to check
        :type bucket_name: str
        :return: Existence state of named bucket
        :rtype: bool
        """
        return

    @abc.abstractmethod
    def thaw(
        self,
        bucket_name: str,
        base_path: str,
        object_keys: list[dict],
        restore_days: int = 7,
        retrieval_tier: str = "Standard",
    ) -> None:
        """
        Return a bucket from deepfreeze_core.

        Args:
            bucket_name (str): The name of the bucket to return.
            base_path (str): The base path to the bucket to return.
            object_keys (list[dict]): A list of object metadata dictionaries (each containing 'Key', 'StorageClass', etc.).
            restore_days (int): The number of days to keep the object restored.
            retrieval_tier (str): The retrieval tier to use.

        Returns:
            None
        """
        return

    @abc.abstractmethod
    def refreeze(
        self, bucket_name: str, path: str, storage_class: str = "GLACIER"
    ) -> None:
        """
        Return a bucket to deepfreeze.

        Args:
            bucket_name (str): The name of the bucket to return.
            path (str): The path to the bucket to return.
            storage_class (str): The storage class to send the data to.

        """
        return

    @abc.abstractmethod
    def list_objects(self, bucket_name: str, prefix: str) -> list[dict]:
        """
        List objects in a bucket with a given prefix.

        Args:
            bucket_name (str): The name of the bucket to list objects from.
            prefix (str): The prefix to use when listing objects.

        Returns:
            list[dict]: A list of object metadata dictionaries (each containing 'Key', 'StorageClass', etc.).
        """
        return

    @abc.abstractmethod
    def delete_bucket(self, bucket_name: str, force: bool = False) -> None:
        """
        Delete a bucket with the given name.

        Args:
            bucket_name (str): The name of the bucket to delete.
            force (bool): If True, empty the bucket before deleting it.

        Returns:
            None
        """
        return

    @abc.abstractmethod
    def put_object(self, bucket_name: str, key: str, body: str = "") -> None:
        """
        Put an object in a bucket at the given path.

        Args:
            bucket_name (str): The name of the bucket to put the object in.
            key (str): The key of the object to put.
            body (str): The body of the object to put.

        Returns:
            None
        """
        return

    @abc.abstractmethod
    def list_buckets(self, prefix: str = None) -> list[str]:
        """
        List all buckets.

        Returns:
            list[str]: A list of bucket names.
        """
        return

    @abc.abstractmethod
    def head_object(self, bucket_name: str, key: str) -> dict:
        """
        Retrieve metadata for an object without downloading it.

        Args:
            bucket_name (str): The name of the bucket.
            key (str): The object key.

        Returns:
            dict: Object metadata including Restore status if applicable.
        """
        return

    @abc.abstractmethod
    def copy_object(
        Bucket: str,
        Key: str,
        CopySource: dict[str, str],
        StorageClass: str,
    ) -> None:
        """
        Copy an object from one bucket to another.

        Args:
            source_bucket (str): The name of the source bucket.
            source_key (str): The key of the object to copy.
            dest_bucket (str): The name of the destination bucket.
            dest_key (str): The key for the copied object.

        Returns:
            None
        """
        return


def s3_client_factory(provider: str) -> S3Client:
    """
    s3_client_factory method, returns an S3Client object implemented specific to
    the value of the provider argument.

    Args:
        provider (str): The provider to use for the S3Client object. Should
                        reference an implemented provider (aws, azure, gcp, etc)

    Raises:
        NotImplementedError: raised if the provider is not implemented
        ValueError: raised if the provider string is invalid.

    Returns:
        S3Client: An S3Client object specific to the provider argument.
    """
    if provider == "aws":
        from deepfreeze_core.aws_client import AwsS3Client

        return AwsS3Client()
    elif provider == "azure":
        from deepfreeze_core.azure_client import AzureBlobClient

        return AzureBlobClient()
    elif provider == "gcp":
        # Placeholder for GCP S3Client implementation
        raise NotImplementedError("GCP S3Client is not implemented yet")
    else:
        raise ValueError(f"Unsupported provider: {provider}")


# Backward-compatible re-exports
from deepfreeze_core.aws_client import AwsS3Client  # noqa: E402, F401

__all__ = ["S3Client", "AwsS3Client", "s3_client_factory"]
