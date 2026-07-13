"""Structured error models and exception mapping."""

from pydantic import BaseModel

from deepfreeze_core.exceptions import (
    ActionError,
    DeepfreezeException,
    MissingIndexError,
    MissingSettingsError,
    PreconditionError,
    RepositoryException,
)


class ServiceError(BaseModel):
    """Structured error information."""

    code: str
    message: str
    target: str | None = None
    remediation: str | None = None
    severity: str = "error"  # "error" | "warning"


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


def map_exception_to_error(exc: Exception, target: str | None = None) -> ServiceError:
    """Map a deepfreeze exception to a ServiceError."""
    mapping = ERROR_MAPPING.get(
        type(exc),
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
