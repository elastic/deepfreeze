"""APScheduler integration for recurring deepfreeze jobs.

Jobs come from three sources (in load order):
1. Built-in defaults (e.g., check-thaw-status)
2. Config YAML (`server.scheduled_jobs`)
3. Elasticsearch (`deepfreeze-status` index, doctype: "scheduled_job")

Only source 3 is mutable via the API. Sources 1 and 2 are recreated on
every startup and are never persisted to ES.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from elasticsearch8 import NotFoundError

from deepfreeze_core.constants import STATUS_INDEX

from ..config import ScheduledJobConfig
from ..models.events import Event, EventChannel, EventType

if TYPE_CHECKING:
    from elasticsearch8 import Elasticsearch

    from .orchestrator import DeepfreezeOrchestrator

logger = logging.getLogger("deepfreeze.server.scheduler")

SCHEDULED_JOB_DOCTYPE = "scheduled_job"
SCHEDULED_JOB_ID_PREFIX = "scheduled_job:"

# Built-in default: check thaw status every 60s
DEFAULT_JOBS = [
    ScheduledJobConfig(
        name="check-thaw-status",
        action="thaw_check",
        interval_seconds=60,
    ),
]


class DeepfreezeScheduler:
    """Manages recurring scheduled jobs using APScheduler.

    Built-in job: `check-thaw-status` runs every 60s to auto-complete
    in-progress thaw requests (replaces the hidden _auto_check_thaw
    side effect from the old DeepfreezeService).

    User-configurable jobs are loaded from the server config YAML.
    Jobs added via the API are persisted to Elasticsearch and survive restarts.
    """

    def __init__(self, orchestrator: DeepfreezeOrchestrator) -> None:
        self._orch = orchestrator
        self._scheduler = AsyncIOScheduler()
        self._job_configs: dict[str, ScheduledJobConfig] = {}
        # Track which jobs are persisted in ES (API-added) vs ephemeral (built-in/config)
        self._persisted_jobs: set[str] = set()

    @property
    def _client(self) -> Elasticsearch:
        return self._orch._client

    async def start(self, extra_jobs: list[ScheduledJobConfig] | None = None) -> None:
        """Register default + config-driven + ES-persisted jobs and start the scheduler."""
        all_jobs = list(DEFAULT_JOBS)
        if extra_jobs:
            all_jobs.extend(extra_jobs)

        for job_cfg in all_jobs:
            self._add_job(job_cfg)

        # Load persisted jobs from Elasticsearch
        persisted = self._load_persisted_jobs()
        for job_cfg, paused in persisted:
            if job_cfg.name not in self._job_configs:
                self._add_job(job_cfg)
                self._persisted_jobs.add(job_cfg.name)
                if paused:
                    self._scheduler.pause_job(job_cfg.name)

        self._scheduler.start()
        logger.info(
            "Scheduler started with %d job(s) (%d from ES): %s",
            len(self._job_configs),
            len(self._persisted_jobs),
            ", ".join(self._job_configs.keys()),
        )

    async def stop(self) -> None:
        """Shut down the scheduler."""
        self._scheduler.shutdown(wait=False)
        logger.info("Scheduler stopped")

    # -- Job management API --

    def list_jobs(self) -> list[dict[str, Any]]:
        """List all scheduled jobs with their state."""
        result = []
        for name, cfg in self._job_configs.items():
            ap_job = self._scheduler.get_job(name)
            next_run = None
            if ap_job and ap_job.next_run_time:
                next_run = ap_job.next_run_time.isoformat()
            result.append({
                "name": name,
                "action": cfg.action,
                "params": cfg.params,
                "cron": cfg.cron,
                "interval_seconds": cfg.interval_seconds,
                "paused": ap_job is not None and ap_job.next_run_time is None,
                "next_run": next_run,
                "persisted": name in self._persisted_jobs,
            })
        return result

    def add_job(self, cfg: ScheduledJobConfig) -> dict[str, Any]:
        """Add a new scheduled job at runtime. Persists to ES."""
        if cfg.name in self._job_configs:
            raise ValueError(f"Job '{cfg.name}' already exists")
        self._add_job(cfg)
        self._persist_job(cfg, paused=False)
        self._persisted_jobs.add(cfg.name)
        return {"name": cfg.name, "status": "added"}

    def update_job(self, name: str, cfg: ScheduledJobConfig) -> dict[str, Any]:
        """Update an existing scheduled job. Only persisted jobs can be updated."""
        if name not in self._job_configs:
            raise ValueError(f"Job '{name}' not found")
        if name not in self._persisted_jobs:
            raise ValueError(f"Job '{name}' is built-in and cannot be modified")
        # Remove old APScheduler job
        self._scheduler.remove_job(name)
        del self._job_configs[name]
        # If the name changed, clean up the old ES doc
        if cfg.name != name:
            self._delete_persisted_job(name)
            self._persisted_jobs.discard(name)
            if cfg.name in self._job_configs:
                raise ValueError(f"Job '{cfg.name}' already exists")
        # Re-add with new config
        self._add_job(cfg)
        self._persist_job(cfg, paused=False)
        self._persisted_jobs.add(cfg.name)
        logger.info("Updated scheduled job: %s", cfg.name)
        return {"name": cfg.name, "status": "updated"}

    def remove_job(self, name: str) -> bool:
        """Remove a scheduled job. Returns True if removed."""
        if name not in self._job_configs:
            return False
        self._scheduler.remove_job(name)
        del self._job_configs[name]
        if name in self._persisted_jobs:
            self._delete_persisted_job(name)
            self._persisted_jobs.discard(name)
        logger.info("Removed scheduled job: %s", name)
        return True

    def pause_job(self, name: str) -> bool:
        """Pause a scheduled job."""
        if name not in self._job_configs:
            return False
        self._scheduler.pause_job(name)
        if name in self._persisted_jobs:
            self._update_persisted_job(name, paused=True)
        logger.info("Paused scheduled job: %s", name)
        return True

    def resume_job(self, name: str) -> bool:
        """Resume a paused scheduled job."""
        if name not in self._job_configs:
            return False
        self._scheduler.resume_job(name)
        if name in self._persisted_jobs:
            self._update_persisted_job(name, paused=False)
        logger.info("Resumed scheduled job: %s", name)
        return True

    # -- ES persistence --

    def _es_doc_id(self, name: str) -> str:
        """Deterministic ES document ID for a scheduled job."""
        return f"{SCHEDULED_JOB_ID_PREFIX}{name}"

    def _load_persisted_jobs(self) -> list[tuple[ScheduledJobConfig, bool]]:
        """Load scheduled jobs from Elasticsearch. Returns (config, paused) tuples."""
        try:
            response = self._client.search(
                index=STATUS_INDEX,
                query={"term": {"doctype": SCHEDULED_JOB_DOCTYPE}},
                size=100,
            )
        except Exception as e:
            logger.warning("Failed to load persisted scheduled jobs: %s", e)
            return []

        jobs = []
        for hit in response["hits"]["hits"]:
            src = hit["_source"]
            try:
                cfg = ScheduledJobConfig(
                    name=src["name"],
                    action=src["action"],
                    params=src.get("params", {}),
                    cron=src.get("cron"),
                    interval_seconds=src.get("interval_seconds"),
                )
                paused = src.get("paused", False)
                jobs.append((cfg, paused))
            except Exception as e:
                logger.warning("Skipping malformed persisted job %s: %s", hit["_id"], e)

        logger.info("Loaded %d scheduled job(s) from Elasticsearch", len(jobs))
        return jobs

    def _persist_job(self, cfg: ScheduledJobConfig, paused: bool = False) -> None:
        """Save a scheduled job to Elasticsearch."""
        doc = {
            "doctype": SCHEDULED_JOB_DOCTYPE,
            "name": cfg.name,
            "action": cfg.action,
            "params": cfg.params,
            "cron": cfg.cron,
            "interval_seconds": cfg.interval_seconds,
            "paused": paused,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            self._client.index(
                index=STATUS_INDEX,
                id=self._es_doc_id(cfg.name),
                document=doc,
            )
            logger.info("Persisted scheduled job to ES: %s", cfg.name)
        except Exception as e:
            logger.error("Failed to persist scheduled job '%s': %s", cfg.name, e)

    def _update_persisted_job(self, name: str, **fields: Any) -> None:
        """Update fields on a persisted scheduled job."""
        try:
            self._client.update(
                index=STATUS_INDEX,
                id=self._es_doc_id(name),
                doc=fields,
            )
        except Exception as e:
            logger.error("Failed to update persisted job '%s': %s", name, e)

    def _delete_persisted_job(self, name: str) -> None:
        """Remove a scheduled job from Elasticsearch."""
        try:
            self._client.delete(
                index=STATUS_INDEX,
                id=self._es_doc_id(name),
            )
            logger.info("Deleted persisted scheduled job from ES: %s", name)
        except NotFoundError:
            pass  # already gone
        except Exception as e:
            logger.error("Failed to delete persisted job '%s': %s", name, e)

    # -- Internal --

    def _add_job(self, cfg: ScheduledJobConfig) -> None:
        """Register a job with APScheduler."""
        trigger = self._make_trigger(cfg)
        if trigger is None:
            logger.warning("Skipping job '%s': no cron or interval_seconds", cfg.name)
            return

        self._scheduler.add_job(
            self._execute_scheduled_action,
            trigger=trigger,
            id=cfg.name,
            name=cfg.name,
            kwargs={"job_name": cfg.name, "action": cfg.action, "params": cfg.params},
            replace_existing=True,
        )
        self._job_configs[cfg.name] = cfg

    @staticmethod
    def _make_trigger(cfg: ScheduledJobConfig):
        """Build an APScheduler trigger from config."""
        if cfg.cron:
            return CronTrigger.from_crontab(cfg.cron)
        if cfg.interval_seconds:
            return IntervalTrigger(seconds=cfg.interval_seconds)
        return None

    def _has_in_progress_thaws(self) -> bool:
        """Check the status cache for any in-progress thaw requests."""
        cached = self._orch.status_cache.cached_status
        if cached is None:
            return True  # assume yes if cache not ready
        return any(
            r.get("status") == "in_progress"
            for r in cached.thaw_requests
        )

    async def _execute_scheduled_action(
        self, job_name: str, action: str, params: dict
    ) -> None:
        """Run a scheduled action through the orchestrator's job manager."""
        # Skip thaw_check when no thaw requests are in progress
        if action == "thaw_check" and not self._has_in_progress_thaws():
            logger.debug("Skipping thaw_check: no in-progress thaw requests")
            return

        logger.debug("Scheduler firing: %s (%s)", job_name, action)

        await self._orch.event_bus.publish(Event(
            type=EventType.SCHEDULER_FIRED,
            channel=EventChannel.SCHEDULER,
            data={"job_name": job_name, "action": action},
        ))

        # Map action names to orchestrator methods
        action_map = {
            "rotate": self._orch.rotate,
            "thaw_check": self._orch.thaw_check,
            "cleanup": self._orch.cleanup,
            "repair": self._orch.repair_metadata,
            "refreeze": self._orch.refreeze,
            "update_date_ranges": self._orch.update_date_ranges,
        }

        method = action_map.get(action)
        if not method:
            logger.error("Unknown scheduled action: %s", action)
            return

        try:
            await method(**params)
        except Exception as e:
            logger.error("Scheduled job '%s' failed: %s", job_name, e)
