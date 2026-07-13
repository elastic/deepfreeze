"""Health and readiness endpoints."""

import asyncio
import time

from fastapi import APIRouter, Depends

from ..orchestration.orchestrator import DeepfreezeOrchestrator
from .deps import get_orchestrator

router = APIRouter()

_start_time: float = time.time()


@router.get("/health")
async def health():
    """Basic health check."""
    return {
        "status": "ok",
        "uptime_seconds": round(time.time() - _start_time),
    }


@router.get("/ready")
async def ready(
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Readiness check — verifies ES connectivity and cache state."""
    cache = orch.status_cache

    loop = asyncio.get_running_loop()
    try:
        es_connected = await loop.run_in_executor(None, orch._client.ping)
    except Exception:
        es_connected = False

    cache_age = cache.cache_age_seconds
    return {
        "ready": es_connected and cache.cached_status is not None,
        "es_connected": es_connected,
        "cache_age_seconds": round(cache_age, 1) if cache_age is not None else None,
    }
