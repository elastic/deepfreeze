"""DeepfreezeOrchestrator — replaces DeepfreezeService as the central coordination layer.

Owns the StatusCache, JobManager, and EventBus. All actions go through here.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from elasticsearch8 import Elasticsearch

from deepfreeze_core import (
    Cleanup,
    Refreeze,
    RepairMetadata,
    Rotate,
    Setup,
    Status,
    Thaw,
    UpdateDateRanges,
)
from deepfreeze_core.audit import AuditLogger
from deepfreeze_core.s3client import s3_client_factory
from deepfreeze_core.utilities import (
    check_restore_status,
    get_matching_repos,
    get_settings,
    get_thaw_request,
)

from ..config import ScheduledJobConfig
from ..models.commands import CommandResult
from ..models.errors import map_exception_to_error
from ..models.events import Event, EventChannel, EventType
from ..models.jobs import JobSubmission
from .event_bus import EventBus
from .job_manager import JobManager
from .scheduler import DeepfreezeScheduler
from .status_cache import StatusCache

logger = logging.getLogger("deepfreeze.server.orchestrator")


class DeepfreezeOrchestrator:
    """Central orchestration layer for the deepfreeze server.

    Coordinates StatusCache, JobManager, and EventBus. All mutating actions
    are submitted as background jobs via the JobManager.
    """

    def __init__(
        self,
        client: Elasticsearch,
        refresh_interval: float = 30.0,
    ) -> None:
        self._client = client
        self._audit = AuditLogger(client)

        self.event_bus = EventBus()
        self.status_cache = StatusCache(
            client=client,
            refresh_interval=refresh_interval,
        )
        self.job_manager = JobManager(event_bus=self.event_bus)
        self.scheduler = DeepfreezeScheduler(orchestrator=self)
        self._cleanup_task: asyncio.Task | None = None

    async def start(
        self, scheduled_jobs: list[ScheduledJobConfig] | None = None
    ) -> None:
        """Start background services (cache refresh, scheduler, job cleanup)."""
        await self.status_cache.start()
        await self.scheduler.start(extra_jobs=scheduled_jobs)
        self._cleanup_task = asyncio.create_task(self._job_cleanup_loop())
        logger.info("Orchestrator started")

    async def stop(self) -> None:
        """Stop background services."""
        await self.scheduler.stop()
        await self.status_cache.stop()
        self.job_manager.shutdown()
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
        logger.info("Orchestrator stopped")

    async def _job_cleanup_loop(self) -> None:
        """Periodically clean up old completed jobs."""
        while True:
            await asyncio.sleep(300)
            removed = self.job_manager.cleanup_completed(max_age_seconds=3600)
            if removed:
                logger.debug("Cleaned up %d old jobs", removed)

    # -- Action methods --
    # Each submits a job to the JobManager and returns a JobSubmission.
    # The job runs asynchronously; callers use wait_for_job for sync behavior.

    async def rotate(
        self,
        year: int | None = None,
        month: int | None = None,
        keep: int = 6,
        dry_run: bool = False,
    ) -> JobSubmission:
        action = Rotate(
            client=self._client,
            year=year,
            month=month,
            keep=keep,
            porcelain=True,
            audit=self._audit,
        )
        return await self._submit_action(
            "rotate", action, dry_run=dry_run,
            params={"year": year, "month": month, "keep": keep, "dry_run": dry_run},
        )

    async def thaw_create(
        self,
        start_date: datetime,
        end_date: datetime,
        sync: bool = False,
        duration: int = 30,
        tier: str = "Standard",
        dry_run: bool = False,
    ) -> JobSubmission:
        action = Thaw(
            client=self._client,
            start_date=start_date,
            end_date=end_date,
            sync=sync,
            duration=duration,
            retrieval_tier=tier,
            porcelain=True,
            audit=self._audit,
        )
        return await self._submit_action(
            "thaw", action, dry_run=dry_run,
            params={
                "start_date": start_date.isoformat(),
                "end_date": end_date.isoformat(),
                "duration": duration, "tier": tier, "sync": sync, "dry_run": dry_run,
            },
        )

    async def thaw_check(self, request_id: str | None = None) -> JobSubmission:
        action = Thaw(
            client=self._client,
            request_id=request_id,
            check_all=(request_id is None),
            porcelain=True,
            audit=self._audit,
        )
        return await self._submit_action(
            "thaw_check", action, dry_run=False,
            params={"request_id": request_id},
            invalidate=True,
        )

    async def refreeze(
        self,
        request_id: str | None = None,
        dry_run: bool = False,
    ) -> JobSubmission:
        action = Refreeze(
            client=self._client,
            request_id=request_id,
            all_requests=(request_id is None),
            porcelain=True,
            audit=self._audit,
        )
        return await self._submit_action(
            "refreeze", action, dry_run=dry_run,
            params={"request_id": request_id, "dry_run": dry_run},
        )

    async def cleanup(
        self,
        refrozen_retention_days: int | None = None,
        dry_run: bool = False,
    ) -> JobSubmission:
        action = Cleanup(
            client=self._client,
            refrozen_retention_days=refrozen_retention_days,
            porcelain=True,
            audit=self._audit,
        )
        return await self._submit_action(
            "cleanup", action, dry_run=dry_run,
            params={"refrozen_retention_days": refrozen_retention_days, "dry_run": dry_run},
        )

    async def repair_metadata(self, dry_run: bool = False) -> JobSubmission:
        action = RepairMetadata(
            client=self._client,
            porcelain=True,
            audit=self._audit,
        )
        return await self._submit_action(
            "repair", action, dry_run=dry_run,
            params={"dry_run": dry_run},
        )

    async def update_date_ranges(self, dry_run: bool = False) -> JobSubmission:
        action = UpdateDateRanges(
            client=self._client,
            porcelain=True,
            audit=self._audit,
        )
        return await self._submit_action(
            "update_date_ranges", action, dry_run=dry_run,
            params={"dry_run": dry_run},
        )

    async def setup(
        self,
        repo_name_prefix: str = "deepfreeze",
        bucket_name_prefix: str = "deepfreeze",
        ilm_policy_name: str | None = None,
        index_template_name: str | None = None,
        dry_run: bool = False,
    ) -> JobSubmission:
        action = Setup(
            client=self._client,
            repo_name_prefix=repo_name_prefix,
            bucket_name_prefix=bucket_name_prefix,
            ilm_policy_name=ilm_policy_name,
            index_template_name=index_template_name,
            porcelain=True,
            audit=self._audit,
        )
        return await self._submit_action(
            "setup", action, dry_run=dry_run,
            params={
                "repo_name_prefix": repo_name_prefix,
                "bucket_name_prefix": bucket_name_prefix,
                "dry_run": dry_run,
            },
        )

    async def get_thaw_restore_progress(self, request_id: str) -> list[dict]:
        """Get S3 restore progress for each repo in a thaw request."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._check_restore_progress, request_id)

    # -- Internal helpers --

    async def _submit_action(
        self,
        action_type: str,
        action,
        dry_run: bool,
        params: dict,
        invalidate: bool | None = None,
    ) -> JobSubmission:
        """Submit a core action as a background job.

        Args:
            action_type: Name for display/tracking (rotate, thaw, etc.)
            action: Instantiated core action object
            dry_run: Whether this is a dry run
            params: Parameters dict for audit/display
            invalidate: Override cache invalidation. If None, invalidates
                        on success when not a dry run.
        """
        should_invalidate = invalidate if invalidate is not None else (not dry_run)

        async def run_fn() -> CommandResult:
            result = await self._run_action(action, dry_run=dry_run)
            if result.success and should_invalidate:
                await self._invalidate_and_notify(action_type)
            return result

        return await self.job_manager.submit(
            action_type=action_type,
            params=params,
            run_fn=run_fn,
        )

    async def _run_action(self, action, dry_run: bool = False) -> CommandResult:
        """Run a core action in a thread pool and return structured result."""
        started_at = datetime.now(timezone.utc)
        method_name = "do_dry_run" if dry_run else "do_action"

        try:
            loop = asyncio.get_running_loop()
            method = getattr(action, method_name)
            await loop.run_in_executor(None, method)

            completed_at = datetime.now(timezone.utc)
            duration_ms = int((completed_at - started_at).total_seconds() * 1000)

            details = self._extract_action_details(action)

            return CommandResult(
                success=True,
                action=action.__class__.__name__.lower(),
                dry_run=dry_run,
                summary="Action completed successfully",
                details=details,
                started_at=started_at,
                completed_at=completed_at,
                duration_ms=duration_ms,
            )

        except Exception as e:
            completed_at = datetime.now(timezone.utc)
            duration_ms = int((completed_at - started_at).total_seconds() * 1000)
            error = map_exception_to_error(e)

            return CommandResult(
                success=False,
                action=action.__class__.__name__.lower(),
                dry_run=dry_run,
                summary=f"Action failed: {e}",
                errors=[error],
                started_at=started_at,
                completed_at=completed_at,
                duration_ms=duration_ms,
            )

    @staticmethod
    def _extract_action_details(action) -> list[dict[str, Any]]:
        """Extract structured details from a completed core action."""
        details = []
        if hasattr(action, "_results"):
            for result in action._results:
                details.append({
                    "type": result.get("type", "unknown"),
                    "action": result.get("action", "unknown"),
                    "target": result.get("name") or result.get("request_id"),
                    "status": result.get("status"),
                    "metadata": {
                        k: v
                        for k, v in result.items()
                        if k not in ("type", "action", "name", "request_id", "status")
                    },
                })
        return details

    def _check_restore_progress(self, request_id: str) -> list[dict]:
        """Synchronous S3 restore progress check — runs in thread pool."""
        request = get_thaw_request(self._client, request_id)
        settings = get_settings(self._client)
        s3 = s3_client_factory(settings.provider)
        repo_names = request.get("repos", [])

        all_repos = get_matching_repos(self._client, settings.repo_name_prefix)
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
                status = check_restore_status(s3, repo.bucket, repo.base_path)
                results.append({"repo": name, **status})
            except Exception as e:
                results.append({
                    "repo": name, "total": 0, "restored": 0,
                    "in_progress": 0, "not_restored": 0, "complete": False,
                    "error": str(e),
                })
        return results

    async def _invalidate_and_notify(self, reason: str) -> None:
        """Invalidate cache and publish status change event."""
        await self.status_cache.invalidate()
        await self.event_bus.publish(Event(
            type=EventType.STATUS_CHANGED,
            channel=EventChannel.STATUS,
            data={"reason": f"{reason}_completed"},
        ))
