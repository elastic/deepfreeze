"""Status and cluster health models."""

from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field


class ClusterHealth(BaseModel):
    """Elasticsearch cluster health information."""

    name: str = ""
    status: str = "unknown"  # green, yellow, red
    version: str = ""
    node_count: int = 0


class SystemStatus(BaseModel):
    """Complete system status response."""

    cluster: ClusterHealth = Field(default_factory=ClusterHealth)
    settings: dict[str, Any] | None = None
    repositories: list[dict[str, Any]] = Field(default_factory=list)
    thaw_requests: list[dict[str, Any]] = Field(default_factory=list)
    buckets: list[dict[str, Any]] = Field(default_factory=list)
    ilm_policies: list[dict[str, Any]] = Field(default_factory=list)
    initialized: bool = False
    errors: list[Any] = Field(default_factory=list)
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ActionHistoryEntry(BaseModel):
    """Entry in the action history log."""

    timestamp: datetime
    action: str
    dry_run: bool
    success: bool
    summary: str
    error_count: int = 0
