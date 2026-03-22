"""Error mapping for deepfreeze-service."""

from deepfreeze_core.exceptions import (
    ActionError,
    DeepfreezeException,
    MissingIndexError,
    MissingSettingsError,
    PreconditionError,
    RepositoryException,
)

from .models import ServiceError


ERROR_MAPPING = {
    MissingIndexError: {
        "code": "MISSING_INDEX",
        "remediation": "Run 'deepfreeze setup' to initialize the system.",
    },
    MissingSettingsError: {
        "code": "MISSING_SETTINGS",
        "remediation": "Run 'deepfreeze setup' to create initial configuration.",
    },
    PreconditionError: {
        "code": "PRECONDITION_FAILED",
        "remediation": "Check the error details and resolve the preconditions before retrying.",
    },
    RepositoryException: {
        "code": "REPOSITORY_ERROR",
        "remediation": "Verify repository configuration and Elasticsearch connectivity.",
    },
    ActionError: {
        "code": "ACTION_FAILED",
        "remediation": "Review the error message and check system logs for details.",
    },
    DeepfreezeException: {
        "code": "DEEPFREEZE_ERROR",
        "remediation": "Check system configuration and try again.",
    },
}


def map_exception_to_error(exc: Exception, target: str = None) -> ServiceError:
    """Map a deepfreeze exception to a ServiceError.

    Args:
        exc: The exception that was raised
        target: Optional target entity (repo name, request ID, etc.)

    Returns:
        A ServiceError with structured information
    """
    exc_type = type(exc)

    # Look up error mapping
    mapping = ERROR_MAPPING.get(
        exc_type,
        {
            "code": "INTERNAL_ERROR",
            "remediation": "An unexpected error occurred. Check logs for details.",
        },
    )

    return ServiceError(
        code=mapping["code"],
        message=str(exc),
        target=target,
        remediation=mapping.get("remediation"),
        severity="error",
    )


def map_exceptions_to_errors(exceptions: list[Exception]) -> list[ServiceError]:
    """Map multiple exceptions to ServiceErrors."""
    return [map_exception_to_error(exc) for exc in exceptions]
