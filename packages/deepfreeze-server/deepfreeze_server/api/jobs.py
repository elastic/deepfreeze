"""Job tracking API routes."""

from fastapi import APIRouter, Depends, HTTPException

from ..models.jobs import JobStatus
from ..orchestration.orchestrator import DeepfreezeOrchestrator
from .deps import get_orchestrator

router = APIRouter()


@router.get("/jobs")
async def list_jobs(
    status: str | None = None,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """List all tracked jobs, optionally filtered by status."""
    filter_status = JobStatus(status) if status else None
    jobs = orch.job_manager.list_jobs(status=filter_status)
    return {"jobs": [j.model_dump() for j in jobs]}


@router.get("/jobs/{job_id}")
async def get_job(
    job_id: str,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Get a specific job by ID."""
    job = orch.job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    return job.model_dump()


@router.delete("/jobs/{job_id}")
async def cancel_job(
    job_id: str,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Cancel a running or pending job."""
    cancelled = await orch.job_manager.cancel(job_id)
    if not cancelled:
        raise HTTPException(
            status_code=409,
            detail=f"Job {job_id} cannot be cancelled (not found or already finished)",
        )
    return {"job_id": job_id, "status": "cancelled"}
