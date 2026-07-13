"""Tests for audit logging functionality"""

import json
from datetime import datetime, timezone
from io import StringIO
from unittest.mock import MagicMock, patch

import pytest

from deepfreeze_core.audit import (
    AUDIT_INDEX,
    ActionTracker,
    AuditLogger,
    ensure_audit_index,
)


class TestAuditLogger:
    """Tests for the AuditLogger class"""

    def test_audit_logger_initialization(self):
        """Test AuditLogger can be initialized"""
        mock_client = MagicMock()
        audit = AuditLogger(mock_client)

        assert audit.client == mock_client
        assert audit.enabled is True
        assert audit._version is not None

    def test_audit_logger_disabled(self):
        """Test disabled AuditLogger does nothing"""
        mock_client = MagicMock()
        audit = AuditLogger(mock_client, enabled=False)

        # Should not interact with client when disabled
        audit.ensure_audit_index()
        mock_client.indices.create.assert_not_called()

        result = audit.log_action(
            action="test",
            dry_run=False,
            success=True,
            duration_ms=100,
            parameters={},
            results=[],
            errors=[],
        )
        assert result is False

    def test_ensure_audit_index_creates_when_missing(self):
        """Test ensure_audit_index creates index when missing"""
        mock_client = MagicMock()
        mock_client.indices.exists.return_value = False

        audit = AuditLogger(mock_client)
        result = audit.ensure_audit_index()

        assert result is True
        mock_client.indices.create.assert_called_once()
        # Verify index name
        call_args = mock_client.indices.create.call_args
        assert call_args[1]["index"] == AUDIT_INDEX

    def test_ensure_audit_index_skips_when_exists(self):
        """Test ensure_audit_index does nothing when index exists"""
        mock_client = MagicMock()
        mock_client.indices.exists.return_value = True

        audit = AuditLogger(mock_client)
        result = audit.ensure_audit_index()

        assert result is True
        mock_client.indices.create.assert_not_called()

    def test_log_action_creates_document(self):
        """Test log_action indexes a document"""
        mock_client = MagicMock()
        mock_client.indices.exists.return_value = True

        audit = AuditLogger(mock_client)
        result = audit.log_action(
            action="rotate",
            dry_run=False,
            success=True,
            duration_ms=5000,
            parameters={"keep": 6},
            results=[{"type": "repository", "action": "created"}],
            errors=[],
            summary={"new_repo": "deepfreeze-000001"},
        )

        assert result is True
        mock_client.index.assert_called_once()

        # Verify document structure
        call_args = mock_client.index.call_args
        assert call_args[1]["index"] == AUDIT_INDEX
        doc = call_args[1]["body"]
        assert doc["action"] == "rotate"
        assert doc["dry_run"] is False
        assert doc["success"] is True
        assert doc["duration_ms"] == 5000
        assert doc["parameters"] == {"keep": 6}
        assert "timestamp" in doc
        assert "user" in doc
        assert "hostname" in doc
        assert "version" in doc

    def test_log_action_silently_fails_on_error(self):
        """Test log_action returns False on ES error without raising"""
        mock_client = MagicMock()
        mock_client.indices.exists.return_value = True
        mock_client.index.side_effect = Exception("Connection refused")

        audit = AuditLogger(mock_client)
        result = audit.log_action(
            action="test",
            dry_run=False,
            success=True,
            duration_ms=100,
            parameters={},
            results=[],
            errors=[],
        )

        # Should return False, not raise
        assert result is False

    def test_get_recent_entries_returns_list(self):
        """Test get_recent_entries fetches audit records"""
        mock_client = MagicMock()
        mock_client.indices.exists.return_value = True
        mock_client.search.return_value = {
            "hits": {
                "hits": [
                    {"_source": {"action": "rotate", "success": True}},
                    {"_source": {"action": "thaw", "success": True}},
                ]
            }
        }

        audit = AuditLogger(mock_client)
        entries = audit.get_recent_entries(limit=10)

        assert len(entries) == 2
        assert entries[0]["action"] == "rotate"
        assert entries[1]["action"] == "thaw"

        # Verify search was called with correct parameters
        mock_client.search.assert_called_once()
        call_args = mock_client.search.call_args
        assert call_args[1]["index"] == AUDIT_INDEX

    def test_get_recent_entries_returns_empty_on_error(self):
        """Test get_recent_entries returns empty list on error"""
        mock_client = MagicMock()
        mock_client.indices.exists.side_effect = Exception("Connection refused")

        audit = AuditLogger(mock_client)
        entries = audit.get_recent_entries()

        assert entries == []

    def test_get_recent_entries_with_action_filter(self):
        """Test get_recent_entries with action filter"""
        mock_client = MagicMock()
        mock_client.indices.exists.return_value = True
        mock_client.search.return_value = {"hits": {"hits": []}}

        audit = AuditLogger(mock_client)
        audit.get_recent_entries(limit=5, action_filter="rotate")

        # Verify search includes filter
        call_args = mock_client.search.call_args
        query = call_args[1]["body"]["query"]
        assert query == {"term": {"action": "rotate"}}


class TestActionTracker:
    """Tests for the ActionTracker class"""

    def test_tracker_initialization(self):
        """Test ActionTracker initialization"""
        tracker = ActionTracker("rotate", dry_run=False, parameters={"keep": 6})

        assert tracker.action == "rotate"
        assert tracker.dry_run is False
        assert tracker.parameters == {"keep": 6}
        assert tracker.results == []
        assert tracker.errors == []
        assert tracker.summary is None
        assert tracker.success is True  # Starts as True

    def test_add_result(self):
        """Test adding results to tracker"""
        tracker = ActionTracker("setup", dry_run=False, parameters={})

        tracker.add_result(
            {"type": "repository", "action": "created", "name": "repo-1"}
        )
        tracker.add_result({"type": "ilm_policy", "action": "updated"})

        assert len(tracker.results) == 2
        assert tracker.results[0]["type"] == "repository"
        assert tracker.results[1]["type"] == "ilm_policy"

    def test_add_error_marks_failed(self):
        """Test adding error marks tracker as failed"""
        tracker = ActionTracker("rotate", dry_run=False, parameters={})

        assert tracker.success is True

        tracker.add_error({"code": "MISSING_INDEX", "message": "Index not found"})

        assert tracker.success is False
        assert len(tracker.errors) == 1
        assert tracker.errors[0]["code"] == "MISSING_INDEX"

    def test_set_summary(self):
        """Test setting summary"""
        tracker = ActionTracker("cleanup", dry_run=False, parameters={})

        tracker.set_summary({"expired_repos_cleaned": 5})

        assert tracker.summary == {"expired_repos_cleaned": 5}

    def test_mark_success_and_failed(self):
        """Test explicit success/failure marking"""
        tracker = ActionTracker("thaw", dry_run=False, parameters={})

        tracker.mark_failed()
        assert tracker.success is False

        tracker.mark_success()
        assert tracker.success is True

    def test_duration_ms(self):
        """Test duration calculation"""
        import time

        tracker = ActionTracker("test", dry_run=False, parameters={})
        time.sleep(0.01)  # 10ms

        duration = tracker.duration_ms
        assert duration >= 10  # At least 10ms

    def test_to_dict(self):
        """Test tracker serialization to dict"""
        tracker = ActionTracker("rotate", dry_run=False, parameters={"keep": 6})
        tracker.add_result({"type": "repository", "action": "created"})
        tracker.add_error({"code": "ERROR", "message": "Test error"})
        tracker.set_summary({"new_repo": "repo-1"})

        data = tracker.to_dict()

        assert data["action"] == "rotate"
        assert data["dry_run"] is False
        assert data["success"] is False  # Because error was added
        assert data["parameters"] == {"keep": 6}
        assert len(data["results"]) == 1
        assert len(data["errors"]) == 1
        assert data["summary"] == {"new_repo": "repo-1"}
        assert "duration_ms" in data


class TestAuditContextManager:
    """Tests for the audit.track() context manager"""

    def test_context_manager_logs_on_success(self):
        """Test context manager logs when action succeeds"""
        mock_client = MagicMock()
        mock_client.indices.exists.return_value = True

        audit = AuditLogger(mock_client)

        with audit.track("rotate", dry_run=False, parameters={"keep": 6}) as tracker:
            tracker.add_result({"type": "repository", "action": "created"})
            tracker.set_summary({"new_repo": "deepfreeze-000001"})

        # Verify log_action was called via commit
        mock_client.index.assert_called_once()
        call_args = mock_client.index.call_args
        doc = call_args[1]["body"]
        assert doc["action"] == "rotate"
        assert doc["success"] is True
        assert len(doc["results"]) == 1

    def test_context_manager_logs_on_failure(self):
        """Test context manager logs even when action fails"""
        mock_client = MagicMock()
        mock_client.indices.exists.return_value = True

        audit = AuditLogger(mock_client)

        try:
            with audit.track("rotate", dry_run=False, parameters={}) as tracker:
                tracker.add_result({"type": "repository", "action": "created"})
                raise ValueError("Test exception")
        except ValueError:
            pass  # Expected

        # Verify log_action was called even though exception was raised
        mock_client.index.assert_called_once()
        call_args = mock_client.index.call_args
        doc = call_args[1]["body"]
        assert doc["action"] == "rotate"
        assert doc["success"] is False  # Marked as failed due to exception


class TestEnsureAuditIndexConvenienceFunction:
    """Tests for the ensure_audit_index convenience function"""

    def test_convenience_function_creates_index(self):
        """Test ensure_audit_index creates index"""
        mock_client = MagicMock()
        mock_client.indices.exists.return_value = False

        result = ensure_audit_index(mock_client)

        assert result is True
        mock_client.indices.create.assert_called_once()
