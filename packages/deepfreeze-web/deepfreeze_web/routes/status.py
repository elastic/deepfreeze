"""Status and read-only API routes."""

from fastapi import APIRouter, Request

from deepfreeze_service import DeepfreezeService

router = APIRouter()


def _get_service(request: Request) -> DeepfreezeService:
    return request.app.state.service


@router.get("/status")
async def get_status(request: Request, force_refresh: bool = False):
    """Get full system status (cluster, repos, thaw requests, buckets, ILM)."""
    service = _get_service(request)
    status = await service.get_status(force_refresh=force_refresh)
    return status.model_dump()


@router.get("/status/cluster")
async def get_cluster_health(request: Request):
    """Get cluster health only."""
    service = _get_service(request)
    status = await service.get_status()
    return (
        status.cluster.model_dump()
        if hasattr(status.cluster, "model_dump")
        else status.cluster
    )


@router.get("/status/repositories")
async def get_repositories(request: Request):
    """Get all repositories."""
    service = _get_service(request)
    status = await service.get_status()
    return {"repositories": status.repositories}


@router.get("/status/thaw-requests")
async def get_thaw_requests(request: Request):
    """Get all thaw requests."""
    service = _get_service(request)
    status = await service.get_status()
    return {"thaw_requests": status.thaw_requests}


@router.get("/status/buckets")
async def get_buckets(request: Request):
    """Get all buckets."""
    service = _get_service(request)
    status = await service.get_status()
    return {"buckets": status.buckets}


@router.get("/status/ilm-policies")
async def get_ilm_policies(request: Request):
    """Get all ILM policies."""
    service = _get_service(request)
    status = await service.get_status()
    return {"ilm_policies": status.ilm_policies}


@router.get("/history")
async def get_action_history(request: Request, limit: int = 25):
    """Get recent action history."""
    service = _get_service(request)
    history = service.get_action_history(limit=limit)
    return {"history": [h.model_dump() for h in history]}


@router.get("/audit")
async def get_audit_log(
    request: Request, limit: int = 50, action: str | None = None
):
    """Get detailed audit log entries from the ES audit index.

    Returns full audit records including parameters, results, user, and hostname.
    """
    service = _get_service(request)
    audit = service._get_audit()
    if not audit:
        return {"entries": [], "source": "unavailable"}
    entries = audit.get_recent_entries(limit=limit, action_filter=action)
    return {"entries": entries, "source": "elasticsearch"}
