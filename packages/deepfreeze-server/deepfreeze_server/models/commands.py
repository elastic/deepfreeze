"""Request models for action commands."""

from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field


class CommandResult(BaseModel):
    """Result of executing a command."""

    success: bool
    action: str
    dry_run: bool
    summary: str
    details: list[dict[str, Any]] = Field(default_factory=list)
    errors: list[Any] = Field(default_factory=list)
    raw_output: str = ""
    started_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: datetime | None = None
    duration_ms: int = 0


# -- Action request models --


class RotateRequest(BaseModel):
    year: int | None = None
    month: int | None = None
    keep: int = 6
    dry_run: bool = False


class ThawCreateRequest(BaseModel):
    start_date: str  # ISO 8601
    end_date: str  # ISO 8601
    duration: int = 30
    tier: str = "Standard"
    sync: bool = False
    dry_run: bool = False


class ThawCheckRequest(BaseModel):
    request_id: str | None = None


class RefreezeRequest(BaseModel):
    request_id: str | None = None
    dry_run: bool = False


class CleanupRequest(BaseModel):
    refrozen_retention_days: int | None = None
    dry_run: bool = False


class RepairRequest(BaseModel):
    dry_run: bool = False


class SetupRequest(BaseModel):
    repo_name_prefix: str = "deepfreeze"
    bucket_name_prefix: str = "deepfreeze"
    ilm_policy_name: str | None = None
    index_template_name: str | None = None
    dry_run: bool = False
