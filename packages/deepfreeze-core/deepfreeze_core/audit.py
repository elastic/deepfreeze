"""Audit logging for deepfreeze actions.

Records all mutating actions to the deepfreeze-audit Elasticsearch index.
Read-only actions (status) are excluded from audit logging.

This module provides:
- AuditLogger: Main class for logging actions to ES
- ActionTracker: Helper class for accumulating results during action execution
"""

import json
import logging
import socket
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from elasticsearch8 import Elasticsearch

from deepfreeze_core.constants import STATUS_INDEX

# Index for audit records
AUDIT_INDEX = "deepfreeze-audit"


@dataclass
class ActionResult:
    """A single result entry from an action."""

    type: str
    action: str
    target: Optional[str] = None
    status: Optional[str] = None
    metadata: dict = field(default_factory=dict)


@dataclass
class ActionError:
    """A single error entry from an action."""

    code: str
    message: str
    target: Optional[str] = None


class ActionTracker:
    """Accumulates results and errors during action execution.

    This class is used by AuditLogger to track what happens during an action.
    It's yielded by the track() context manager so actions can add results.

    Example:
        with audit.track("rotate", dry_run=False, parameters={...}) as tracker:
            # Do work
            tracker.add_result({"type": "repository", "action": "created", ...})
            tracker.set_summary({"new_repo": "deepfreeze-000001"})
    """

    def __init__(self, action: str, dry_run: bool, parameters: dict):
        self.action = action
        self.dry_run = dry_run
        self.parameters = parameters
        self.results: list[dict] = []
        self.errors: list[dict] = []
        self.summary: Optional[dict] = None
        self._success = True
        self._start_time = datetime.now(timezone.utc)

    def add_result(self, result: dict) -> None:
        """Add a result entry to the tracker.

        Args:
            result: A dictionary with at least 'type' and 'action' keys.
                   Common types: 'repository', 'ilm_policy', 'thaw_request', etc.
        """
        self.results.append(result)

    def add_error(self, error: dict) -> None:
        """Add an error entry to the tracker and mark the action as failed.

        Args:
            error: A dictionary with 'code' and 'message' keys.
        """
        self.errors.append(error)
        self._success = False

    def set_summary(self, summary: dict) -> None:
        """Set the summary for this action.

        Args:
            summary: Dictionary with summary information (counts, key identifiers, etc.)
        """
        self.summary = summary

    def mark_success(self) -> None:
        """Explicitly mark the action as successful."""
        self._success = True

    def mark_failed(self) -> None:
        """Explicitly mark the action as failed."""
        self._success = False

    @property
    def success(self) -> bool:
        """Whether the action was successful (no errors added)."""
        return self._success

    @property
    def duration_ms(self) -> int:
        """Calculate duration in milliseconds since tracking started."""
        elapsed = datetime.now(timezone.utc) - self._start_time
        return int(elapsed.total_seconds() * 1000)

    def to_dict(self) -> dict:
        """Convert tracker to dictionary format for logging."""
        return {
            "action": self.action,
            "dry_run": self.dry_run,
            "success": self.success,
            "duration_ms": self.duration_ms,
            "parameters": self.parameters,
            "results": self.results,
            "errors": self.errors,
            "summary": self.summary or {},
        }


class AuditLogger:
    """Logs action execution to Elasticsearch for audit trail.

    This logger records all mutating actions (setup, rotate, thaw, refreeze,
    cleanup, repair_metadata) to a dedicated ES index. Read-only actions (status)
    are not logged.

    Key features:
    - Automatic index creation if missing
    - Silent failure mode - audit logging never breaks the action
    - Optional - actions work fine without an audit logger
    - Tracks timing, parameters, results, and errors

    Example:
        audit = AuditLogger(es_client)

        # Method 1: Context manager (recommended)
        with audit.track("rotate", dry_run=False, parameters={"keep": 6}) as tracker:
            # Do the rotation work
            result = create_new_repo(...)
            tracker.add_result({"type": "repository", "action": "created", ...})
        # Automatically logged on exit

        # Method 2: Manual logging
        tracker = audit.start_tracking("thaw", dry_run=False, parameters={...})
        try:
            # Do work
            tracker.add_result({...})
            audit.commit(tracker)
        except Exception as e:
            tracker.add_error({"code": "ERROR", "message": str(e)})
            audit.commit(tracker)
            raise
    """

    def __init__(self, client: Elasticsearch, enabled: bool = True):
        """Initialize the audit logger.

        Args:
            client: Elasticsearch client for writing audit records
            enabled: Whether audit logging is enabled (default: True)
        """
        self.client = client
        self.enabled = enabled
        self.loggit = logging.getLogger("deepfreeze.audit")
        self._version = self._get_version()

    def _get_version(self) -> str:
        """Get the deepfreeze version for audit records."""
        try:
            from deepfreeze_core import __version__

            return __version__
        except ImportError:
            return "unknown"

    def ensure_audit_index(self) -> bool:
        """Ensure the audit index exists, creating it if necessary.

        Returns:
            True if index exists or was created, False on error
        """
        if not self.enabled:
            return False

        try:
            if not self.client.indices.exists(index=AUDIT_INDEX):
                self.loggit.info("Creating audit index %s", AUDIT_INDEX)
                self.client.indices.create(
                    index=AUDIT_INDEX,
                    body={
                        "settings": {
                            "number_of_shards": 1,
                            "number_of_replicas": 1,
                        },
                        "mappings": {
                            "properties": {
                                "timestamp": {"type": "date"},
                                "action": {"type": "keyword"},
                                "dry_run": {"type": "boolean"},
                                "success": {"type": "boolean"},
                                "duration_ms": {"type": "long"},
                                "parameters": {"type": "object", "enabled": False},
                                "results": {"type": "object", "enabled": False},
                                "errors": {"type": "object", "enabled": False},
                                "summary": {"type": "object", "enabled": False},
                                "user": {"type": "keyword"},
                                "hostname": {"type": "keyword"},
                                "version": {"type": "keyword"},
                            }
                        },
                    },
                )
                self.loggit.info("Audit index created successfully")
            return True
        except Exception as e:
            self.loggit.warning("Failed to create audit index: %s", e)
            return False

    def _get_current_user(self) -> Optional[str]:
        """Try to determine the current user from ES connection or environment."""
        # Try to get from ES client info if available
        try:
            # This might be available in some ES client versions
            if hasattr(self.client, "_username"):
                return self.client._username
        except:
            pass

        # Fallback to environment
        import os

        return os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"

    def _get_hostname(self) -> str:
        """Get the current hostname."""
        try:
            return socket.gethostname()
        except:
            return "unknown"

    def log_action(
        self,
        action: str,
        dry_run: bool,
        success: bool,
        duration_ms: int,
        parameters: dict,
        results: list,
        errors: list,
        summary: Optional[dict] = None,
    ) -> bool:
        """Record an action execution to the audit index.

        This method fails silently - if ES is unreachable or the index doesn't
        exist, it logs a warning but doesn't raise an exception. Audit logging
        should never break the actual action.

        Args:
            action: The action name (setup, rotate, thaw, etc.)
            dry_run: Whether this was a dry run
            success: Whether the action succeeded
            duration_ms: Duration in milliseconds
            parameters: Action parameters (arbitrary dict)
            results: List of result dictionaries
            errors: List of error dictionaries
            summary: Optional summary dictionary

        Returns:
            True if logged successfully, False otherwise
        """
        if not self.enabled:
            return False

        try:
            # Ensure index exists
            self.ensure_audit_index()

            # Build the audit document
            doc = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "action": action,
                "dry_run": dry_run,
                "success": success,
                "duration_ms": duration_ms,
                "parameters": parameters,
                "results": results,
                "errors": errors,
                "summary": summary or {},
                "user": self._get_current_user(),
                "hostname": self._get_hostname(),
                "version": self._version,
            }

            # Index the document
            self.client.index(index=AUDIT_INDEX, body=doc)
            self.loggit.debug("Logged %s action to audit index", action)
            return True

        except Exception as e:
            # Fail silently - audit logging should never break the action
            self.loggit.warning("Failed to log audit entry: %s", e)
            return False

    def start_tracking(
        self,
        action: str,
        dry_run: bool,
        parameters: dict,
    ) -> ActionTracker:
        """Start tracking an action for later logging.

        This creates an ActionTracker that you can use to accumulate results
        and errors, then call commit() to log everything.

        Args:
            action: The action name
            dry_run: Whether this is a dry run
            parameters: Action parameters

        Returns:
            An ActionTracker instance
        """
        return ActionTracker(action, dry_run, parameters)

    def commit(self, tracker: ActionTracker) -> bool:
        """Commit a tracker to the audit log.

        Args:
            tracker: The ActionTracker to log

        Returns:
            True if logged successfully
        """
        return self.log_action(
            action=tracker.action,
            dry_run=tracker.dry_run,
            success=tracker.success,
            duration_ms=tracker.duration_ms,
            parameters=tracker.parameters,
            results=tracker.results,
            errors=tracker.errors,
            summary=tracker.summary,
        )

    @contextmanager
    def track(
        self,
        action: str,
        dry_run: bool,
        parameters: dict,
    ):
        """Context manager for tracking an action.

        This is the recommended way to use audit logging. It automatically
        handles success/failure and timing.

        Example:
            with audit.track("rotate", dry_run=False, parameters={"keep": 6}) as tracker:
                # Do work
                tracker.add_result({"type": "repository", "action": "created"})
                tracker.set_summary({"new_repo": "deepfreeze-000001"})

        Args:
            action: The action name
            dry_run: Whether this is a dry run
            parameters: Action parameters

        Yields:
            An ActionTracker that you can use to add results
        """
        tracker = self.start_tracking(action, dry_run, parameters)
        try:
            yield tracker
            # If we get here without exception, mark as success
            tracker.mark_success()
        except Exception:
            # Mark as failed if an exception occurred
            tracker.mark_failed()
            raise
        finally:
            # Always commit (even on failure)
            self.commit(tracker)

    def get_recent_entries(
        self,
        limit: int = 25,
        action_filter: Optional[str] = None,
    ) -> list[dict]:
        """Get recent audit entries from the index.

        This is used by the status command to show recent activity.

        Args:
            limit: Maximum number of entries to return (default: 25)
            action_filter: Optional filter by action name

        Returns:
            List of audit entry dictionaries
        """
        if not self.enabled:
            return []

        try:
            if not self.client.indices.exists(index=AUDIT_INDEX):
                return []

            # Build query
            query = {"match_all": {}}
            if action_filter:
                query = {"term": {"action": action_filter}}

            # Search for recent entries
            response = self.client.search(
                index=AUDIT_INDEX,
                body={
                    "query": query,
                    "sort": [{"timestamp": {"order": "desc"}}],
                    "size": limit,
                },
            )

            # Extract and return hits
            hits = response.get("hits", {}).get("hits", [])
            return [hit["_source"] for hit in hits]

        except Exception as e:
            self.loggit.warning("Failed to fetch audit entries: %s", e)
            return []


def ensure_audit_index(client: Elasticsearch) -> bool:
    """Ensure the audit index exists, creating it if necessary.

    This is a convenience function that can be called without creating
    an AuditLogger instance.

    Args:
        client: Elasticsearch client

    Returns:
        True if index exists or was created
    """
    logger = AuditLogger(client)
    return logger.ensure_audit_index()
