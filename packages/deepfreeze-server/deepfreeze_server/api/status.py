"""Status and read-only API routes."""

import asyncio

from fastapi import APIRouter, Depends

from ..orchestration.orchestrator import DeepfreezeOrchestrator
from .deps import get_orchestrator

router = APIRouter()


@router.get("/status")
async def get_status(
    force_refresh: bool = False,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Get full system status (cluster, repos, thaw requests, buckets, ILM)."""
    status = await orch.status_cache.get_status(force_refresh=force_refresh)
    return status.model_dump()


@router.get("/status/cluster")
async def get_cluster_health(
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Get cluster health only."""
    status = await orch.status_cache.get_status()
    return status.cluster.model_dump()


@router.get("/status/repositories")
async def get_repositories(
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Get all repositories."""
    status = await orch.status_cache.get_status()
    return {"repositories": status.repositories}


@router.get("/status/thaw-requests")
async def get_thaw_requests(
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Get all thaw requests."""
    status = await orch.status_cache.get_status()
    return {"thaw_requests": status.thaw_requests}


@router.get("/status/buckets")
async def get_buckets(
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Get all buckets."""
    status = await orch.status_cache.get_status()
    return {"buckets": status.buckets}


@router.get("/status/ilm-policies")
async def get_ilm_policies(
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Get all ILM policies."""
    status = await orch.status_cache.get_status()
    return {"ilm_policies": status.ilm_policies}


@router.get("/history")
async def get_action_history(
    limit: int = 25,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Get recent action history."""
    loop = asyncio.get_running_loop()
    history = await loop.run_in_executor(
        None, orch.status_cache.get_action_history, limit
    )
    return {"history": [h.model_dump() for h in history]}


@router.get("/thaw-requests/{request_id}/restore-progress")
async def get_restore_progress(
    request_id: str,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Get S3 restore progress for each repo in a thaw request."""
    progress = await orch.get_thaw_restore_progress(request_id)
    return {"request_id": request_id, "repos": progress}


@router.get("/audit")
async def get_audit_log(
    limit: int = 50,
    action: str | None = None,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Get detailed audit log entries from the ES audit index."""
    audit = orch._audit
    if not audit:
        return {"entries": [], "source": "unavailable"}
    loop = asyncio.get_running_loop()
    entries = await loop.run_in_executor(
        None, lambda: audit.get_recent_entries(limit=limit, action_filter=action)
    )
    return {"entries": entries, "source": "elasticsearch"}
