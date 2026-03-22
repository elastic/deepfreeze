"""Deepfreeze Service Layer

Async service layer wrapping deepfreeze-core for UI consumption.
Provides structured models, error handling, and polling management.
"""

__version__ = "1.0.0"

# Export models
from .models import (
    ActionDetail,
    ActionHistoryEntry,
    BucketInfo,
    ClusterHealth,
    CommandResult,
    IlmPolicyInfo,
    PollingConfig,
    RepositoryInfo,
    ServiceError,
    SettingsInfo,
    SystemStatus,
    ThawRequestInfo,
)

# Export service
from .service import DeepfreezeService

# Export errors
from .errors import map_exception_to_error

__all__ = [
    "__version__",
    # Service
    "DeepfreezeService",
    # Models
    "SystemStatus",
    "ClusterHealth",
    "SettingsInfo",
    "RepositoryInfo",
    "ThawRequestInfo",
    "BucketInfo",
    "IlmPolicyInfo",
    "ServiceError",
    "CommandResult",
    "ActionDetail",
    "ActionHistoryEntry",
    "PollingConfig",
    # Errors
    "map_exception_to_error",
]
