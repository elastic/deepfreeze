"""Pydantic models for deepfreeze-service."""

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


class ServiceError(BaseModel):
    """Structured error information."""

    code: str
    message: str
    target: Optional[str] = None
    remediation: Optional[str] = None
    severity: str = "error"  # "error" | "warning"


class ClusterHealth(BaseModel):
    """Elasticsearch cluster health information."""

    name: str = ""
    status: str = "unknown"  # green, yellow, red
    version: str = ""
    node_count: int = 0


class SystemStatus(BaseModel):
    """Complete system status response.

    Uses plain dicts/lists for repositories, thaw_requests, buckets,
    and ilm_policies to avoid schema mismatches with the porcelain
    JSON output from the Status action.
    """

    cluster: ClusterHealth = Field(default_factory=ClusterHealth)
    settings: Optional[dict[str, Any]] = None
    repositories: list[dict[str, Any]] = Field(default_factory=list)
    thaw_requests: list[dict[str, Any]] = Field(default_factory=list)
    buckets: list[dict[str, Any]] = Field(default_factory=list)
    ilm_policies: list[dict[str, Any]] = Field(default_factory=list)
    initialized: bool = False
    errors: list[ServiceError] = Field(default_factory=list)
    timestamp: datetime = Field(default_factory=datetime.utcnow)

    class Config:
        json_encoders = {datetime: lambda v: v.isoformat()}


class ActionDetail(BaseModel):
    """Single action result item."""

    type: str
    action: str
    target: Optional[str] = None
    status: Optional[str] = None
    metadata: dict = Field(default_factory=dict)


class CommandResult(BaseModel):
    """Result of executing a command."""

    success: bool
    action: str
    dry_run: bool
    summary: str
    details: list[ActionDetail] = Field(default_factory=list)
    errors: list[ServiceError] = Field(default_factory=list)
    raw_output: str = ""
    started_at: datetime = Field(default_factory=datetime.utcnow)
    completed_at: Optional[datetime] = None
    duration_ms: int = 0

    class Config:
        json_encoders = {datetime: lambda v: v.isoformat()}


class ActionHistoryEntry(BaseModel):
    """Entry in the action history log."""

    timestamp: datetime
    action: str
    dry_run: bool
    success: bool
    summary: str
    error_count: int = 0

    class Config:
        json_encoders = {datetime: lambda v: v.isoformat()}


class PollingConfig(BaseModel):
    """Configuration for status polling."""

    enabled: bool = True
    interval_seconds: int = 30
    stale_threshold_seconds: int = 60
