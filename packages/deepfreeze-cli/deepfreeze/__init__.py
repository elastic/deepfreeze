"""
Deepfreeze - Standalone Elasticsearch S3 Glacier archival tool

This package provides cost-effective S3 Glacier archival and lifecycle management
for Elasticsearch snapshot repositories without requiring full Curator installation.

Core functionality is provided by the deepfreeze-core package.
This package adds the CLI and configuration management.
"""

__version__ = "1.0.1"

# Re-export everything from deepfreeze-core for backward compatibility
from deepfreeze_core import (
    PROVIDERS,
    SETTINGS_ID,
    # Constants
    STATUS_INDEX,
    THAW_STATE_EXPIRED,
    THAW_STATE_FROZEN,
    THAW_STATE_THAWED,
    THAW_STATE_THAWING,
    ActionError,
    ActionException,
    AwsS3Client,
    Cleanup,
    # Helper classes
    Deepfreeze,
    # Exceptions
    DeepfreezeException,
    ESClientWrapper,
    MissingIndexError,
    MissingSettingsError,
    PreconditionError,
    Refreeze,
    RepairMetadata,
    Repository,
    RepositoryException,
    Rotate,
    # S3 Client
    S3Client,
    Settings,
    # Actions
    Setup,
    Status,
    Thaw,
    # ES Client
    create_es_client,
    create_es_client_from_config,
    load_config_from_yaml,
    s3_client_factory,
    validate_connection,
)

__all__ = [
    "__version__",
    # Exceptions
    "DeepfreezeException",
    "MissingIndexError",
    "MissingSettingsError",
    "ActionException",
    "PreconditionError",
    "RepositoryException",
    "ActionError",
    # Constants
    "STATUS_INDEX",
    "SETTINGS_ID",
    "PROVIDERS",
    "THAW_STATE_FROZEN",
    "THAW_STATE_THAWING",
    "THAW_STATE_THAWED",
    "THAW_STATE_EXPIRED",
    # Helper classes
    "Deepfreeze",
    "Repository",
    "Settings",
    # S3 Client
    "S3Client",
    "AwsS3Client",
    "s3_client_factory",
    # ES Client
    "create_es_client",
    "create_es_client_from_config",
    "load_config_from_yaml",
    "validate_connection",
    "ESClientWrapper",
    # Actions
    "Setup",
    "Status",
    "Rotate",
    "Thaw",
    "Refreeze",
    "Cleanup",
    "RepairMetadata",
]
