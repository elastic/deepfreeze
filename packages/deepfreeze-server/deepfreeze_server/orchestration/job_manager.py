"""Background job submission, tracking, and cancellation.

Phase 1: Infrastructure is in place but actions still run synchronously.
Phase 2 will make all actions go through the job manager.
"""

import asyncio
import logging
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from ..models.commands import CommandResult
from ..models.errors import map_exception_to_error
from ..models.events import Event, EventChannel, EventType
from ..models.jobs import Job, JobStatus, JobSubmission
from .event_bus import EventBus

logger = logging.getLogger("deepfreeze.server.jobs")

# Cap concurrent core actions to avoid overloading ES
MAX_WORKERS = 4


class JobManager:
    """Manages background job execution with progress tracking.

    Jobs are in-memory only. Completed jobs are recorded in the ES audit index
    (already handled by deepfreeze-core actions). If the server restarts,
    in-flight jobs are lost — core actions are idempotent, so this is safe.
    """

    def __init__(self, event_bus: EventBus) -> None:
        self._jobs: dict[str, Job] = {}
        self._event_bus = event_bus
        self._executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)
        self._tasks: dict[str, asyncio.Task] = {}

    @property
    def jobs(self) -> dict[str, Job]:
        return self._jobs

    def get_job(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def list_jobs(self, status: JobStatus | None = None) -> list[Job]:
        jobs = list(self._jobs.values())
        if status is not None:
            jobs = [j for j in jobs if j.status == status]
        return sorted(jobs, key=lambda j: j.submitted_at, reverse=True)

    async def submit(
        self,
        action_type: str,
        params: dict,
        run_fn,
        submitted_by: str = "api",
    ) -> JobSubmission:
        """Submit a new background job.

        Args:
            action_type: Name of the action (rotate, thaw, etc.)
            params: Action parameters for audit/display
            run_fn: Async callable that performs the work and returns CommandResult
            submitted_by: Identifier for who submitted the job

        Returns:
            JobSubmission with the assigned job_id
        """
        job_id = uuid.uuid4().hex[:12]
        while job_id in self._jobs:
            job_id = uuid.uuid4().hex[:12]
        job = Job(
            id=job_id,
            type=action_type,
            params=params,
            submitted_by=submitted_by,
        )
        self._jobs[job_id] = job

        # Launch the job as a background task
        task = asyncio.create_task(self._run_job(job, run_fn))
        self._tasks[job_id] = task

        logger.info("Job %s submitted: %s %s", job_id, action_type, params)
        return JobSubmission(job_id=job_id, status=JobStatus.PENDING)

    async def wait_for_job(self, job_id: str, timeout: float = 30.0) -> Job | None:
        """Wait for a job to reach a terminal state.

        Returns the Job if it completes within the timeout, or None if it
        times out. The job keeps running regardless.
        """
        job = self._jobs.get(job_id)
        if not job:
            return None
        task = self._tasks.get(job_id)
        if not task:
            return job
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
        except asyncio.TimeoutError:
            pass
        except asyncio.CancelledError:
            pass
        return self._jobs.get(job_id)

    async def cancel(self, job_id: str) -> bool:
        """Cancel a running job. Returns True if cancelled."""
        job = self._jobs.get(job_id)
        if not job or job.status not in (JobStatus.PENDING, JobStatus.RUNNING):
            return False

        task = self._tasks.get(job_id)
        if task and not task.done():
            task.cancel()

        job.status = JobStatus.CANCELLED
        job.completed_at = datetime.now(timezone.utc)

        await self._event_bus.publish(Event(
            type=EventType.JOB_CANCELLED,
            channel=EventChannel.JOBS,
            data={"job_id": job_id, "type": job.type},
        ))

        logger.info("Job %s cancelled", job_id)
        return True

    async def _run_job(self, job: Job, run_fn) -> None:
        """Execute a job and update its state."""
        job.status = JobStatus.RUNNING
        job.started_at = datetime.now(timezone.utc)

        await self._event_bus.publish(Event(
            type=EventType.JOB_STARTED,
            channel=EventChannel.JOBS,
            data={"job_id": job.id, "type": job.type},
        ))

        try:
            result: CommandResult = await run_fn()

            job.status = JobStatus.COMPLETED if result.success else JobStatus.FAILED
            job.completed_at = datetime.now(timezone.utc)
            job.result = result

            event_type = EventType.JOB_COMPLETED if result.success else EventType.JOB_FAILED
            await self._event_bus.publish(Event(
                type=event_type,
                channel=EventChannel.JOBS,
                data={
                    "job_id": job.id,
                    "type": job.type,
                    "success": result.success,
                    "summary": result.summary,
                },
            ))

            logger.info("Job %s %s: %s", job.id, job.status, result.summary)

        except asyncio.CancelledError:
            job.status = JobStatus.CANCELLED
            job.completed_at = datetime.now(timezone.utc)
            raise

        except Exception as e:
            job.status = JobStatus.FAILED
            job.completed_at = datetime.now(timezone.utc)
            job.error = map_exception_to_error(e)

            await self._event_bus.publish(Event(
                type=EventType.JOB_FAILED,
                channel=EventChannel.JOBS,
                data={"job_id": job.id, "type": job.type, "error": str(e)},
            ))

            logger.error("Job %s failed: %s", job.id, e)

    def shutdown(self) -> None:
        """Shut down the thread pool executor."""
        self._executor.shutdown(wait=False)

    def cleanup_completed(self, max_age_seconds: float = 3600) -> int:
        """Remove completed/failed/cancelled jobs older than max_age_seconds."""
        now = datetime.now(timezone.utc)
        to_remove = []
        for job_id, job in self._jobs.items():
            if job.status in (JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED):
                if job.completed_at:
                    age = (now - job.completed_at).total_seconds()
                    if age > max_age_seconds:
                        to_remove.append(job_id)
        for job_id in to_remove:
            del self._jobs[job_id]
            self._tasks.pop(job_id, None)
        return len(to_remove)
