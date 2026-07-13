"""Job lifecycle models."""

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field

from .commands import CommandResult
from .errors import ServiceError


class JobStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class JobProgress(BaseModel):
    percent: float = 0.0
    message: str = ""
    steps: list[str] = Field(default_factory=list)


class Job(BaseModel):
    """A tracked background job."""

    id: str
    type: str  # action name: rotate, thaw, cleanup, etc.
    status: JobStatus = JobStatus.PENDING
    params: dict[str, Any] = Field(default_factory=dict)
    submitted_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    started_at: datetime | None = None
    completed_at: datetime | None = None
    progress: JobProgress = Field(default_factory=JobProgress)
    result: CommandResult | None = None
    error: ServiceError | None = None
    submitted_by: str = "unknown"


class JobSubmission(BaseModel):
    """Response returned when a job is submitted (202 Accepted)."""

    job_id: str
    status: JobStatus = JobStatus.PENDING
