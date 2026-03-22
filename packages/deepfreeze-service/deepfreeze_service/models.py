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

    name: str
    status: str  # green, yellow, red
    version: str
    node_count: int


class RepositoryInfo(BaseModel):
    """Repository information for UI display."""

    name: str
    state: str  # active, frozen, thawing, thawed, expired
    mounted: bool
    bucket: str
    base_path: str
    date_range_start: Optional[datetime] = None
    date_range_end: Optional[datetime] = None
    storage_tier: Optional[str] = None
    expires_at: Optional[datetime] = None


class ThawRequestInfo(BaseModel):
    """Thaw request information."""

    request_id: str
    status: str  # in_progress, completed, failed, refrozen
    start_date: datetime
    end_date: datetime
    repos: list[str]
    created_at: datetime
    age_days: int = 0


class BucketInfo(BaseModel):
    """Storage bucket information."""

    name: str
    provider: str
    region: Optional[str] = None


class IlmPolicyInfo(BaseModel):
    """ILM policy information."""

    name: str
    repo: Optional[str] = None
    searchable_snapshot_enabled: bool = False


class SettingsInfo(BaseModel):
    """Deepfreeze settings information."""

    repo_name_prefix: str
    bucket_name_prefix: str
    base_path_prefix: str
    provider: str
    rotate_by: str
    ilm_policy_name: Optional[str] = None


class SystemStatus(BaseModel):
    """Complete system status response."""

    cluster: ClusterHealth
    settings: Optional[SettingsInfo] = None
    repositories: list[RepositoryInfo] = Field(default_factory=list)
    thaw_requests: list[ThawRequestInfo] = Field(default_factory=list)
    buckets: list[BucketInfo] = Field(default_factory=list)
    ilm_policies: list[IlmPolicyInfo] = Field(default_factory=list)
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
