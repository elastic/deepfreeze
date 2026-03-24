"""Main service layer for deepfreeze.

This module provides the DeepfreezeService class which wraps deepfreeze-core
actions and provides async, structured interfaces for the TUI and Web UI.
"""

import asyncio
import json
import logging
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from io import StringIO
from typing import Any, Optional

from elasticsearch8 import Elasticsearch

from deepfreeze_core import (
    Cleanup,
    Refreeze,
    RepairMetadata,
    Rotate,
    Setup,
    Status,
    Thaw,
)
from deepfreeze_core.audit import AuditLogger
from deepfreeze_core.esclient import create_es_client

# Import config loading from CLI module (same as deepfreeze CLI)
try:
    from deepfreeze.config import get_elasticsearch_config, load_config
except ImportError:
    # Fallback if deepfreeze CLI not installed
    from deepfreeze_core.esclient import create_es_client_from_config

    def load_config(path):
        return {}

    def get_elasticsearch_config(config):
        return {}


from .errors import map_exception_to_error
from .models import (
    ActionHistoryEntry,
    ClusterHealth,
    CommandResult,
    PollingConfig,
    ServiceError,
    SystemStatus,
)


class DeepfreezeService:
    """Async service layer wrapping deepfreeze-core for UI consumption.

    This class provides:
    - Async wrappers for all deepfreeze actions
    - Structured response models (no raw CLI output parsing)
    - Automatic error mapping to ServiceError objects
    - In-memory action history tracking
    - Status polling with configurable intervals

    Example:
        service = DeepfreezeService(config_path="/etc/deepfreeze/config.yml")
        status = await service.get_status()
        result = await service.rotate(year=2026, month=3, keep=6)
    """

    def __init__(
        self,
        config_path: Optional[str] = None,
        client: Optional[Elasticsearch] = None,
        polling_config: Optional[PollingConfig] = None,
    ):
        """Initialize the service.

        Args:
            config_path: Path to YAML config file (optional if client provided)
            client: Pre-configured ES client (optional, will create if not provided)
            polling_config: Configuration for status polling
        """
        self.loggit = logging.getLogger("deepfreeze.service")
        self.config_path = config_path
        self._client = client
        self._client_owned = client is None
        self.polling_config = polling_config or PollingConfig()

        # Action history (in-memory, limited size)
        self._action_history: list[ActionHistoryEntry] = []
        self._max_history = 100

        # Cached status
        self._last_status: Optional[SystemStatus] = None
        self._last_status_time: Optional[datetime] = None

        # Thaw check throttle — avoid checking on every status poll
        self._last_thaw_check_time: Optional[datetime] = None
        self._thaw_check_interval = 60  # seconds between automatic checks

        # Create audit logger if client available
        self._audit: Optional[AuditLogger] = None
        if self._client:
            self._audit = AuditLogger(self._client)

    @property
    def client(self) -> Elasticsearch:
        """Get or create Elasticsearch client."""
        if self._client is None:
            if self.config_path:
                # Load config the same way as CLI
                config = load_config(self.config_path)
                es_config = get_elasticsearch_config(config)
                self._client = create_es_client(**es_config)
            else:
                raise ValueError("Either config_path or client must be provided")
            self._client_owned = True

            # Create audit logger with new client
            if self._audit is None:
                self._audit = AuditLogger(self._client)

        return self._client

    def _get_audit(self) -> Optional[AuditLogger]:
        """Get audit logger, creating if necessary."""
        if self._audit is None and self._client is not None:
            self._audit = AuditLogger(self._client)
        return self._audit

    def _add_to_history(self, result: CommandResult) -> None:
        """Add a command result to action history."""
        entry = ActionHistoryEntry(
            timestamp=result.completed_at or datetime.now(timezone.utc),
            action=result.action,
            dry_run=result.dry_run,
            success=result.success,
            summary=result.summary,
            error_count=len(result.errors),
        )
        self._action_history.insert(0, entry)

        # Trim history if needed
        if len(self._action_history) > self._max_history:
            self._action_history = self._action_history[: self._max_history]

    def get_action_history(self, limit: int = 25) -> list[ActionHistoryEntry]:
        """Get recent action history from ES audit log, falling back to in-memory."""
        audit = self._get_audit()
        if audit:
            try:
                entries = audit.get_recent_entries(limit=limit)
                if entries:
                    return [
                        ActionHistoryEntry(
                            timestamp=e.get("timestamp", ""),
                            action=e.get("action", "unknown"),
                            dry_run=e.get("dry_run", False),
                            success=e.get("success", False),
                            summary=self._summarize_audit_entry(e),
                            error_count=len(e.get("errors", [])),
                        )
                        for e in entries
                    ]
            except Exception:
                pass  # Fall back to in-memory
        return self._action_history[:limit]

    @staticmethod
    def _summarize_audit_entry(entry: dict) -> str:
        """Build a summary string from an ES audit entry."""
        summary = entry.get("summary", {})
        if isinstance(summary, dict) and summary:
            parts = [f"{k}: {v}" for k, v in summary.items()]
            return ", ".join(parts)
        results = entry.get("results", [])
        if results:
            return f"{len(results)} result(s)"
        return ""

    async def _run_action(
        self, action, method_name: str = "do_action"
    ) -> CommandResult:
        """Run an action in a thread pool and return structured result.

        Args:
            action: The action instance to run
            method_name: Method to call (do_action or do_dry_run)

        Returns:
            CommandResult with structured output
        """
        started_at = datetime.now(timezone.utc)

        try:
            # Run blocking action in thread pool
            loop = asyncio.get_event_loop()
            method = getattr(action, method_name)
            await loop.run_in_executor(None, method)

            # Build success result from action attributes
            completed_at = datetime.now(timezone.utc)
            duration_ms = int((completed_at - started_at).total_seconds() * 1000)

            # Extract results from action (if available)
            details = []
            if hasattr(action, "_results"):
                for result in action._results:
                    details.append(
                        {
                            "type": result.get("type", "unknown"),
                            "action": result.get("action", "unknown"),
                            "target": result.get("name") or result.get("request_id"),
                            "status": result.get("status"),
                            "metadata": {
                                k: v
                                for k, v in result.items()
                                if k
                                not in [
                                    "type",
                                    "action",
                                    "name",
                                    "request_id",
                                    "status",
                                ]
                            },
                        }
                    )

            # Build summary
            summary_parts = []
            if hasattr(action, "new_repo_name"):
                summary_parts.append(f"Created repository {action.new_repo_name}")

            cmd_result = CommandResult(
                success=True,
                action=action.__class__.__name__.lower(),
                dry_run=method_name == "do_dry_run",
                summary="; ".join(summary_parts)
                if summary_parts
                else "Action completed successfully",
                details=details,
                started_at=started_at,
                completed_at=completed_at,
                duration_ms=duration_ms,
            )

        except Exception as e:
            completed_at = datetime.now(timezone.utc)
            duration_ms = int((completed_at - started_at).total_seconds() * 1000)

            error = map_exception_to_error(e)
            cmd_result = CommandResult(
                success=False,
                action=action.__class__.__name__.lower(),
                dry_run=method_name == "do_dry_run",
                summary=f"Action failed: {str(e)}",
                errors=[error],
                started_at=started_at,
                completed_at=completed_at,
                duration_ms=duration_ms,
            )

        # Add to history
        self._add_to_history(cmd_result)

        return cmd_result

    async def get_status(
        self,
        sections: Optional[list[str]] = None,
        limit: Optional[int] = None,
        force_refresh: bool = False,
    ) -> SystemStatus:
        """Get current system status.

        Args:
            sections: List of sections to include (None = all)
            limit: Max items per list section
            force_refresh: Bypass cache and fetch fresh data

        Returns:
            SystemStatus with all requested information
        """
        # Check if we can use cached status
        if not force_refresh and self._last_status and self._last_status_time:
            cache_age = (
                datetime.now(timezone.utc) - self._last_status_time
            ).total_seconds()
            if cache_age < self.polling_config.interval_seconds:
                return self._last_status

        status = await self._fetch_status_once(limit)

        # If there are in-progress thaw requests, periodically run a thaw
        # status check so the UI reflects completed restores without requiring
        # a manual `deepfreeze thaw --check-status` from the CLI.
        if self._should_check_thaw(status):
            try:
                self.loggit.info("Auto-checking in-progress thaw requests")
                await self._auto_check_thaw()
                # Re-fetch status after the check may have updated state
                status = await self._fetch_status_once(limit)
            except Exception as e:
                self.loggit.warning("Auto thaw check failed: %s", e)

        # Cache the result
        self._last_status = status
        self._last_status_time = datetime.now(timezone.utc)

        return status

    async def _fetch_status_once(
        self, limit: Optional[int] = None
    ) -> SystemStatus:
        """Fetch status from deepfreeze-core without caching or thaw checks."""
        try:
            action = Status(
                client=self.client,
                porcelain=True,
                limit=limit,
            )

            f = StringIO()
            with redirect_stdout(f):
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(None, action.do_action)

            output = f.getvalue().strip()
            if not output:
                raise ValueError("Status action returned no output")
            data = json.loads(output)

            status = SystemStatus(
                cluster=self._get_cluster_health(),
                initialized=data.get("initialized", True),
                repositories=data.get("repositories", []),
                thaw_requests=data.get("thaw_requests", []),
                buckets=data.get("buckets", []),
                ilm_policies=data.get("ilm_policies", []),
                settings=data.get("settings"),
                errors=[],
                timestamp=datetime.now(timezone.utc),
            )

            self.loggit.info(
                "Status fetched: %d repos, %d thaw requests",
                len(status.repositories),
                len(status.thaw_requests),
            )
            return status

        except Exception as e:
            error = map_exception_to_error(e)
            self.loggit.error("Failed to get status: %s", e)
            return SystemStatus(
                cluster=self._get_cluster_health(),
                initialized=False,
                errors=[error],
                timestamp=datetime.now(timezone.utc),
            )

    def _should_check_thaw(self, status: SystemStatus) -> bool:
        """Check if we should auto-run a thaw status check.

        Returns True if there are in-progress thaw requests and enough time
        has elapsed since the last automatic check.
        """
        has_in_progress = any(
            r.get("status") == "in_progress"
            for r in status.thaw_requests
        )
        if not has_in_progress:
            return False

        if self._last_thaw_check_time:
            elapsed = (
                datetime.now(timezone.utc) - self._last_thaw_check_time
            ).total_seconds()
            if elapsed < self._thaw_check_interval:
                return False

        return True

    async def _auto_check_thaw(self) -> None:
        """Run thaw --check-all to update in-progress thaw request states."""
        self._last_thaw_check_time = datetime.now(timezone.utc)
        action = Thaw(
            client=self.client,
            check_all=True,
            porcelain=True,
        )

        def _run():
            # Suppress all output — we only care about the side effects
            # (state updates in ES). porcelain=True avoids rich tables,
            # and we redirect both stdout and stderr to discard everything.
            devnull = StringIO()
            with redirect_stdout(devnull), redirect_stderr(devnull):
                action.do_action()

        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _run)

    def _get_cluster_health(self) -> ClusterHealth:
        """Get basic cluster health info."""
        try:
            info = self.client.info()
            health = self.client.cluster.health(timeout="5s")
            return ClusterHealth(
                name=info.get("cluster_name", "unknown"),
                status=health.get("status", "unknown"),
                version=info.get("version", {}).get("number", "unknown"),
                node_count=health.get("number_of_nodes", 1),
            )
        except Exception:
            return ClusterHealth(
                name="unreachable",
                status="red",
                version="unknown",
                node_count=0,
            )

    # Command wrappers

    async def rotate(
        self,
        year: Optional[int] = None,
        month: Optional[int] = None,
        keep: int = 1,
        dry_run: bool = False,
    ) -> CommandResult:
        """Execute rotate command."""
        action = Rotate(
            client=self.client,
            year=year,
            month=month,
            keep=keep,
            porcelain=True,
            audit=self._get_audit(),
        )
        return await self._run_action(action, "do_dry_run" if dry_run else "do_action")

    async def thaw_create(
        self,
        start_date: datetime,
        end_date: datetime,
        sync: bool = False,
        duration: int = 7,
        tier: str = "Standard",
        dry_run: bool = False,
    ) -> CommandResult:
        """Create a new thaw request."""
        action = Thaw(
            client=self.client,
            start_date=start_date,
            end_date=end_date,
            sync=sync,
            duration=duration,
            retrieval_tier=tier,
            porcelain=True,
            audit=self._get_audit(),
        )
        return await self._run_action(action, "do_dry_run" if dry_run else "do_action")

    async def thaw_check(self, request_id: Optional[str] = None) -> CommandResult:
        """Check thaw status."""
        action = Thaw(
            client=self.client,
            request_id=request_id,
            check_all=(request_id is None),
            porcelain=True,
            audit=self._get_audit(),
        )
        return await self._run_action(action, "do_action")

    async def get_thaw_restore_progress(self, request_id: str) -> list[dict]:
        """Get restore progress for each repo in a thaw request.

        Calls S3 head_object on each object to determine restore status.
        Only meaningful for in_progress requests.

        Returns list of dicts with: repo, total, restored, in_progress,
        not_restored, complete.
        """
        from deepfreeze_core.utilities import (
            check_restore_status,
            get_thaw_request,
            get_matching_repos,
            get_settings,
        )
        from deepfreeze_core.s3client import s3_client_factory

        def _check():
            request = get_thaw_request(self.client, request_id)
            settings = get_settings(self.client)
            s3 = s3_client_factory(settings.provider)
            repo_names = request.get("repos", [])

            # Get repo objects for bucket/path info
            all_repos = get_matching_repos(
                self.client, settings.repo_name_prefix
            )
            repo_map = {r.name: r for r in all_repos}

            results = []
            for name in repo_names:
                repo = repo_map.get(name)
                if not repo:
                    results.append({
                        "repo": name, "total": 0, "restored": 0,
                        "in_progress": 0, "not_restored": 0, "complete": False,
                        "error": "repo not found",
                    })
                    continue
                try:
                    status = check_restore_status(s3, repo)
                    results.append({"repo": name, **status})
                except Exception as e:
                    results.append({
                        "repo": name, "total": 0, "restored": 0,
                        "in_progress": 0, "not_restored": 0, "complete": False,
                        "error": str(e),
                    })
            return results

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _check)

    async def thaw_list(self, include_completed: bool = False) -> CommandResult:
        """List thaw requests."""
        action = Thaw(
            client=self.client,
            list_requests=True,
            include_completed=include_completed,
            porcelain=True,
            audit=self._get_audit(),
        )
        return await self._run_action(action, "do_action")

    async def refreeze(
        self,
        request_id: Optional[str] = None,
        dry_run: bool = False,
    ) -> CommandResult:
        """Refreeze thawed data.

        Args:
            request_id: Specific thaw request to refreeze. If None, refreezes all completed requests.
            dry_run: If True, show what would happen without making changes.
        """
        action = Refreeze(
            client=self.client,
            request_id=request_id,
            all_requests=(request_id is None),
            porcelain=True,
            audit=self._get_audit(),
        )
        return await self._run_action(action, "do_dry_run" if dry_run else "do_action")

    async def cleanup(
        self,
        refrozen_retention_days: Optional[int] = None,
        dry_run: bool = False,
    ) -> CommandResult:
        """Clean up old resources."""
        action = Cleanup(
            client=self.client,
            refrozen_retention_days=refrozen_retention_days,
            porcelain=True,
            audit=self._get_audit(),
        )
        return await self._run_action(action, "do_dry_run" if dry_run else "do_action")

    async def repair_metadata(self, dry_run: bool = False) -> CommandResult:
        """Repair metadata inconsistencies."""
        action = RepairMetadata(
            client=self.client,
            porcelain=True,
            audit=self._get_audit(),
        )
        return await self._run_action(action, "do_dry_run" if dry_run else "do_action")

    async def setup(
        self,
        repo_name_prefix: str = "deepfreeze",
        bucket_name_prefix: str = "deepfreeze",
        ilm_policy_name: Optional[str] = None,
        index_template_name: Optional[str] = None,
        dry_run: bool = False,
    ) -> CommandResult:
        """Initialize deepfreeze."""
        action = Setup(
            client=self.client,
            repo_name_prefix=repo_name_prefix,
            bucket_name_prefix=bucket_name_prefix,
            ilm_policy_name=ilm_policy_name,
            index_template_name=index_template_name,
            porcelain=True,
            audit=self._get_audit(),
        )
        return await self._run_action(action, "do_dry_run" if dry_run else "do_action")
