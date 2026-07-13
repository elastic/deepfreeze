"""Deepfreeze Exceptions

This module contains all exception classes used by the standalone deepfreeze package.
These exceptions are independent of curator and provide specific error handling
for deepfreeze operations.
"""


class DeepfreezeException(Exception):
    """
    Base class for all exceptions raised by Deepfreeze which are not Elasticsearch
    exceptions.
    """


class MissingIndexError(DeepfreezeException):
    """
    Exception raised when the status index is missing
    """


class MissingSettingsError(DeepfreezeException):
    """
    Exception raised when the status index exists, but the settings document is missing
    """


class ActionException(DeepfreezeException):
    """
    Generic class for unexpected conditions during DF actions
    """


class PreconditionError(DeepfreezeException):
    """
    Exception raised when preconditions are not met for a deepfreeze action.

    The `issues` attribute carries a list of plain-text issue descriptions
    so callers (CLI, server API) can surface the details.
    """

    def __init__(self, message: str, issues: list[str] | None = None):
        super().__init__(message)
        self.issues = issues or []


class RepositoryException(DeepfreezeException):
    """
    Exception raised when a problem with a repository occurs
    """


class ActionError(DeepfreezeException):
    """
    Exception raised when an action (against an index_list, snapshot_list, or S3 bucket)
    cannot be taken. This is the standalone equivalent of curator.exceptions.ActionError.
    """
