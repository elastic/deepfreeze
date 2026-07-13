"""Pre-cached system status with background refresh and invalidation."""

import asyncio
import logging
from datetime import datetime, timezone

from elasticsearch8 import Elasticsearch

from deepfreeze_core.actions import Status
from deepfreeze_core.audit import AuditLogger
from deepfreeze_core.exceptions import MissingIndexError, MissingSettingsError

from ..models.errors import map_exception_to_error
from ..models.status import ActionHistoryEntry, ClusterHealth, SystemStatus

logger = logging.getLogger("deepfreeze.server.cache")


class StatusCache:
    """Maintains a cached copy of system status, refreshed periodically.

    Calls Status._gather_status_info() directly to bypass the stdout capture
    hack used by the old service layer. This gives us structured data without
    serializing through JSON/stdout.
    """

    def __init__(
        self,
        client: Elasticsearch,
        refresh_interval: float = 30.0,
    ) -> None:
        self._client = client
        self._refresh_interval = refresh_interval
        self._cached: SystemStatus | None = None
        self._cache_time: datetime | None = None
        self._refresh_task: asyncio.Task | None = None
        self._audit = AuditLogger(client)

    @property
    def cached_status(self) -> SystemStatus | None:
        return self._cached

    @property
    def cache_age_seconds(self) -> float | None:
        if self._cache_time is None:
            return None
        return (datetime.now(timezone.utc) - self._cache_time).total_seconds()

    async def start(self) -> None:
        """Perform initial fetch and start background refresh loop."""
        await self.refresh()
        self._refresh_task = asyncio.create_task(self._refresh_loop())

    async def stop(self) -> None:
        """Stop background refresh."""
        if self._refresh_task:
            self._refresh_task.cancel()
            try:
                await self._refresh_task
            except asyncio.CancelledError:
                pass
            self._refresh_task = None

    async def get_status(self, force_refresh: bool = False) -> SystemStatus:
        """Return cached status, optionally forcing a fresh fetch."""
        if force_refresh or self._cached is None:
            await self.refresh()
        return self._cached  # type: ignore[return-value]

    async def invalidate(self) -> None:
        """Invalidate cache and trigger immediate refresh.

        Called after mutating jobs complete (rotate, thaw, etc.).
        """
        logger.info("Cache invalidated, refreshing")
        await self.refresh()

    async def refresh(self) -> None:
        """Fetch fresh status from Elasticsearch via deepfreeze-core."""
        loop = asyncio.get_running_loop()
        try:
            status = await loop.run_in_executor(None, self._fetch_status)
            self._cached = status
            self._cache_time = datetime.now(timezone.utc)
            logger.info(
                "Status refreshed: %d repos, %d thaw requests",
                len(status.repositories),
                len(status.thaw_requests),
            )
        except Exception as e:
            logger.error("Failed to refresh status: %s", e)
            if self._cached is None:
                # First fetch failed — provide an error status
                self._cached = SystemStatus(
                    cluster=self._get_cluster_health(),
                    initialized=False,
                    errors=[map_exception_to_error(e)],
                    timestamp=datetime.now(timezone.utc),
                )
                self._cache_time = datetime.now(timezone.utc)

    def _fetch_status(self) -> SystemStatus:
        """Synchronous status fetch — runs in thread pool.

        Calls Status._gather_status_info() directly to get structured data
        without going through stdout/porcelain serialization.
        """
        action = Status(client=self._client, porcelain=True)

        try:
            repos, thaw_requests, buckets, ilm_policies = action._gather_status_info()
        except (MissingIndexError, MissingSettingsError) as e:
            return SystemStatus(
                cluster=self._get_cluster_health(),
                initialized=False,
                errors=[map_exception_to_error(e)],
                timestamp=datetime.now(timezone.utc),
            )

        settings_dict = None
        if action.settings:
            settings_dict = action.settings.to_dict()

        return SystemStatus(
            cluster=self._get_cluster_health(),
            initialized=True,
            settings=settings_dict,
            repositories=repos,
            thaw_requests=thaw_requests,
            buckets=buckets,
            ilm_policies=ilm_policies,
            errors=[],
            timestamp=datetime.now(timezone.utc),
        )

    def _get_cluster_health(self) -> ClusterHealth:
        """Get basic cluster health info."""
        try:
            info = self._client.info()
            health = self._client.cluster.health(timeout="5s")
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

    def get_action_history(self, limit: int = 25) -> list[ActionHistoryEntry]:
        """Get recent action history from the ES audit log."""
        try:
            entries = self._audit.get_recent_entries(limit=limit)
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
            return []

    @staticmethod
    def _summarize_audit_entry(entry: dict) -> str:
        summary = entry.get("summary", {})
        if isinstance(summary, dict) and summary:
            parts = [f"{k}: {v}" for k, v in summary.items()]
            return ", ".join(parts)
        results = entry.get("results", [])
        if results:
            return f"{len(results)} result(s)"
        return ""

    async def _refresh_loop(self) -> None:
        """Background loop that refreshes the cache periodically."""
        while True:
            await asyncio.sleep(self._refresh_interval)
            try:
                await self.refresh()
            except Exception as e:
                logger.error("Background refresh failed: %s", e)
