"""Scheduler API routes."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..config import ScheduledJobConfig
from ..orchestration.orchestrator import DeepfreezeOrchestrator
from .deps import get_orchestrator

router = APIRouter()


class JobRequest(BaseModel):
    name: str
    action: str
    params: dict[str, Any] = {}
    cron: str | None = None
    interval_seconds: int | None = None


@router.get("/scheduler/jobs")
async def list_scheduled_jobs(
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """List all scheduled jobs."""
    return {"jobs": orch.scheduler.list_jobs()}


@router.post("/scheduler/jobs")
async def add_scheduled_job(
    body: JobRequest,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Add a new scheduled job."""
    cfg = ScheduledJobConfig(
        name=body.name,
        action=body.action,
        params=body.params,
        cron=body.cron,
        interval_seconds=body.interval_seconds,
    )
    try:
        result = orch.scheduler.add_job(cfg)
        return result
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.put("/scheduler/jobs/{name}")
async def update_scheduled_job(
    name: str,
    body: JobRequest,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Update an existing scheduled job."""
    cfg = ScheduledJobConfig(
        name=body.name,
        action=body.action,
        params=body.params,
        cron=body.cron,
        interval_seconds=body.interval_seconds,
    )
    try:
        result = orch.scheduler.update_job(name, cfg)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/scheduler/jobs/{name}")
async def remove_scheduled_job(
    name: str,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Remove a scheduled job."""
    if not orch.scheduler.remove_job(name):
        raise HTTPException(status_code=404, detail=f"Job '{name}' not found")
    return {"name": name, "status": "removed"}


@router.post("/scheduler/jobs/{name}/pause")
async def pause_scheduled_job(
    name: str,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Pause a scheduled job."""
    if not orch.scheduler.pause_job(name):
        raise HTTPException(status_code=404, detail=f"Job '{name}' not found")
    return {"name": name, "status": "paused"}


@router.post("/scheduler/jobs/{name}/resume")
async def resume_scheduled_job(
    name: str,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Resume a paused scheduled job."""
    if not orch.scheduler.resume_job(name):
        raise HTTPException(status_code=404, detail=f"Job '{name}' not found")
    return {"name": name, "status": "resumed"}
