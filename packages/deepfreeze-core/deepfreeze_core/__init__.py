"""
Deepfreeze Core Library

Core library for Elasticsearch S3 Glacier archival operations.
This package is shared between the standalone deepfreeze CLI and curator.
"""

__version__ = "1.0.1"

# Export constants
# Export actions
from deepfreeze_core.actions import (
    Cleanup,
    Refreeze,
    RepairMetadata,
    Rotate,
    Setup,
    Status,
    Thaw,
)
from deepfreeze_core.constants import (
    PROVIDERS,
    SETTINGS_ID,
    STATUS_INDEX,
    THAW_STATE_EXPIRED,
    THAW_STATE_FROZEN,
    THAW_STATE_THAWED,
    THAW_STATE_THAWING,
)

# Export ES client utilities
from deepfreeze_core.esclient import (
    ESClientWrapper,
    create_es_client,
    create_es_client_from_config,
    get_storage_credentials,
    load_config_from_yaml,
    load_storage_config,
    validate_connection,
)

# Export exceptions
from deepfreeze_core.exceptions import (
    ActionError,
    ActionException,
    DeepfreezeException,
    MissingIndexError,
    MissingSettingsError,
    PreconditionError,
    RepositoryException,
)

# Export helpers
from deepfreeze_core.helpers import (
    Deepfreeze,
    Repository,
    Settings,
)

# Export S3 client
from deepfreeze_core.s3client import (
    AwsS3Client,
    S3Client,
    s3_client_factory,
)

# Conditional Azure export (azure-storage-blob is optional)
try:
    from deepfreeze_core.azure_client import AzureBlobClient
except ImportError:
    AzureBlobClient = None  # type: ignore[misc,assignment]

# Conditional GCP export (google-cloud-storage is optional)
try:
    from deepfreeze_core.gcp_client import GcpStorageClient
except ImportError:
    GcpStorageClient = None  # type: ignore[misc,assignment]

# Export commonly used utilities
from deepfreeze_core.utilities import (
    check_restore_status,
    create_repo,
    decode_date,
    ensure_settings_index,
    find_repos_by_date_range,
    get_all_indices_in_repo,
    get_all_repos,
    get_matching_repo_names,
    get_matching_repos,
    get_next_suffix,
    get_repositories_by_names,
    get_settings,
    get_thaw_request,
    get_timestamp_range,
    list_thaw_requests,
    mount_repo,
    push_to_glacier,
    save_settings,
    save_thaw_request,
    unmount_repo,
    update_repository_date_range,
)

__all__ = [
    # Version
    "__version__",
    # Constants
    "PROVIDERS",
    "SETTINGS_ID",
    "STATUS_INDEX",
    "THAW_STATE_FROZEN",
    "THAW_STATE_THAWING",
    "THAW_STATE_THAWED",
    "THAW_STATE_EXPIRED",
    # Exceptions
    "ActionError",
    "ActionException",
    "DeepfreezeException",
    "MissingIndexError",
    "MissingSettingsError",
    "PreconditionError",
    "RepositoryException",
    # Helpers
    "Deepfreeze",
    "Repository",
    "Settings",
    # S3 Client
    "AwsS3Client",
    "AzureBlobClient",
    "GcpStorageClient",
    "S3Client",
    "s3_client_factory",
    # ES Client
    "ESClientWrapper",
    "create_es_client",
    "create_es_client_from_config",
    "get_storage_credentials",
    "load_config_from_yaml",
    "load_storage_config",
    "validate_connection",
    # Actions
    "Cleanup",
    "Refreeze",
    "RepairMetadata",
    "Rotate",
    "Setup",
    "Status",
    "Thaw",
    # Utilities
    "check_restore_status",
    "create_repo",
    "decode_date",
    "ensure_settings_index",
    "find_repos_by_date_range",
    "get_all_indices_in_repo",
    "get_all_repos",
    "get_matching_repo_names",
    "get_matching_repos",
    "get_next_suffix",
    "get_repositories_by_names",
    "get_settings",
    "get_thaw_request",
    "get_timestamp_range",
    "list_thaw_requests",
    "mount_repo",
    "push_to_glacier",
    "save_settings",
    "save_thaw_request",
    "unmount_repo",
    "update_repository_date_range",
]
