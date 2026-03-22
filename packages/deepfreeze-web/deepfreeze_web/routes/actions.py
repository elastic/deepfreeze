"""Action API routes (mutating operations)."""

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from deepfreeze_service import DeepfreezeService

router = APIRouter()


def _get_service(request: Request) -> DeepfreezeService:
    return request.app.state.service


# -- Request models --


class RotateRequest(BaseModel):
    year: Optional[int] = None
    month: Optional[int] = None
    keep: int = 1
    dry_run: bool = False


class ThawCreateRequest(BaseModel):
    start_date: str  # ISO 8601 date string
    end_date: str  # ISO 8601 date string
    duration: int = 7
    tier: str = "Standard"
    sync: bool = False
    dry_run: bool = False


class ThawCheckRequest(BaseModel):
    request_id: Optional[str] = None


class RefreezeRequest(BaseModel):
    request_id: Optional[str] = None
    dry_run: bool = False


class CleanupRequest(BaseModel):
    refrozen_retention_days: Optional[int] = None
    dry_run: bool = False


class RepairRequest(BaseModel):
    dry_run: bool = False


# -- Action endpoints --


@router.post("/actions/rotate")
async def rotate(request: Request, body: RotateRequest):
    """Execute rotate action."""
    service = _get_service(request)
    result = await service.rotate(
        year=body.year,
        month=body.month,
        keep=body.keep,
        dry_run=body.dry_run,
    )
    return result.model_dump()


@router.post("/actions/thaw")
async def thaw_create(request: Request, body: ThawCreateRequest):
    """Create a new thaw request."""
    service = _get_service(request)
    try:
        start = datetime.fromisoformat(body.start_date)
        end = datetime.fromisoformat(body.end_date)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid date format: {e}")

    result = await service.thaw_create(
        start_date=start,
        end_date=end,
        duration=body.duration,
        tier=body.tier,
        sync=body.sync,
        dry_run=body.dry_run,
    )
    return result.model_dump()


@router.post("/actions/thaw/check")
async def thaw_check(request: Request, body: ThawCheckRequest):
    """Check thaw request status."""
    service = _get_service(request)
    result = await service.thaw_check(request_id=body.request_id)
    return result.model_dump()


@router.post("/actions/refreeze")
async def refreeze(request: Request, body: RefreezeRequest):
    """Refreeze thawed data."""
    service = _get_service(request)
    result = await service.refreeze(
        request_id=body.request_id,
        dry_run=body.dry_run,
    )
    return result.model_dump()


@router.post("/actions/cleanup")
async def cleanup(request: Request, body: CleanupRequest):
    """Clean up expired repos and old thaw requests."""
    service = _get_service(request)
    result = await service.cleanup(
        refrozen_retention_days=body.refrozen_retention_days,
        dry_run=body.dry_run,
    )
    return result.model_dump()


@router.post("/actions/repair")
async def repair_metadata(request: Request, body: RepairRequest):
    """Repair metadata inconsistencies."""
    service = _get_service(request)
    result = await service.repair_metadata(dry_run=body.dry_run)
    return result.model_dump()
