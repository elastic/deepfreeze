"""Event models for the SSE event bus."""

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class EventChannel(StrEnum):
    JOBS = "jobs"
    STATUS = "status"
    THAW = "thaw"
    SCHEDULER = "scheduler"


class EventType(StrEnum):
    JOB_STARTED = "job.started"
    JOB_PROGRESS = "job.progress"
    JOB_COMPLETED = "job.completed"
    JOB_FAILED = "job.failed"
    JOB_CANCELLED = "job.cancelled"
    STATUS_CHANGED = "status.changed"
    THAW_COMPLETED = "thaw.completed"
    SCHEDULER_FIRED = "scheduler.fired"


class Event(BaseModel):
    """An event published on the event bus and delivered via SSE."""

    type: EventType
    channel: EventChannel
    data: dict[str, Any] = Field(default_factory=dict)
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
