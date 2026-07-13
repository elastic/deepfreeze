"""Action API routes (mutating operations).

All actions are submitted as background jobs, returning 202 Accepted with a
job_id by default. Use ?wait=true&timeout=30 to hold the response until the
job completes (for CLI convenience and Web UI backward compat).
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from ..models.commands import (
    CleanupRequest,
    RefreezeRequest,
    RepairRequest,
    RotateRequest,
    SetupRequest,
    ThawCheckRequest,
    ThawCreateRequest,
)
from ..models.jobs import JobStatus, JobSubmission
from ..orchestration.orchestrator import DeepfreezeOrchestrator
from .deps import get_orchestrator

router = APIRouter()


async def _submit_or_wait(
    orch: DeepfreezeOrchestrator,
    submission: JobSubmission,
    wait: bool,
    timeout: float,
) -> JSONResponse:
    """Return 202 with job_id, or wait for completion and return the result."""
    if not wait:
        return JSONResponse(
            status_code=202,
            content=submission.model_dump(mode="json"),
        )

    job = await orch.job_manager.wait_for_job(submission.job_id, timeout=timeout)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job.status in (JobStatus.COMPLETED, JobStatus.FAILED):
        # Return the CommandResult directly for backward compat with Web UI
        if job.result:
            return JSONResponse(content=job.result.model_dump(mode="json"))
        return JSONResponse(content=job.model_dump(mode="json"))

    # Job still running after timeout — return 202 with current state
    return JSONResponse(status_code=202, content=job.model_dump(mode="json"))


@router.post("/actions/rotate")
async def rotate(
    body: RotateRequest,
    wait: bool = True,
    timeout: float = 120,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Execute rotate action."""
    submission = await orch.rotate(
        year=body.year,
        month=body.month,
        keep=body.keep,
        dry_run=body.dry_run,
    )
    return await _submit_or_wait(orch, submission, wait, timeout)


@router.post("/actions/thaw")
async def thaw_create(
    body: ThawCreateRequest,
    wait: bool = True,
    timeout: float = 120,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Create a new thaw request."""
    try:
        start = datetime.fromisoformat(body.start_date)
        end = datetime.fromisoformat(body.end_date)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid date format: {e}")

    submission = await orch.thaw_create(
        start_date=start,
        end_date=end,
        duration=body.duration,
        tier=body.tier,
        sync=body.sync,
        dry_run=body.dry_run,
    )
    return await _submit_or_wait(orch, submission, wait, timeout)


@router.post("/actions/thaw/check")
async def thaw_check(
    body: ThawCheckRequest,
    wait: bool = True,
    timeout: float = 120,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Check thaw request status."""
    submission = await orch.thaw_check(request_id=body.request_id)
    return await _submit_or_wait(orch, submission, wait, timeout)


@router.post("/actions/refreeze")
async def refreeze(
    body: RefreezeRequest,
    wait: bool = True,
    timeout: float = 120,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Refreeze thawed data."""
    submission = await orch.refreeze(
        request_id=body.request_id,
        dry_run=body.dry_run,
    )
    return await _submit_or_wait(orch, submission, wait, timeout)


@router.post("/actions/cleanup")
async def cleanup(
    body: CleanupRequest,
    wait: bool = True,
    timeout: float = 120,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Clean up expired repos and old thaw requests."""
    submission = await orch.cleanup(
        refrozen_retention_days=body.refrozen_retention_days,
        dry_run=body.dry_run,
    )
    return await _submit_or_wait(orch, submission, wait, timeout)


@router.post("/actions/repair")
async def repair_metadata(
    body: RepairRequest,
    wait: bool = True,
    timeout: float = 120,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Repair metadata inconsistencies."""
    submission = await orch.repair_metadata(dry_run=body.dry_run)
    return await _submit_or_wait(orch, submission, wait, timeout)


@router.post("/actions/setup")
async def setup(
    body: SetupRequest,
    wait: bool = True,
    timeout: float = 120,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Initialize deepfreeze."""
    submission = await orch.setup(
        repo_name_prefix=body.repo_name_prefix,
        bucket_name_prefix=body.bucket_name_prefix,
        ilm_policy_name=body.ilm_policy_name,
        index_template_name=body.index_template_name,
        dry_run=body.dry_run,
    )
    return await _submit_or_wait(orch, submission, wait, timeout)
