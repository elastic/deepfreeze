"""Server configuration — YAML config file + environment variable overrides."""

import logging
import os
import sys
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field

logger = logging.getLogger("deepfreeze.server.config")

DEFAULT_CONFIG_PATH = Path.home() / ".deepfreeze" / "config.yml"


class ScheduledJobConfig(BaseModel):
    """A single scheduled job definition from config."""

    name: str
    action: str  # rotate, thaw_check, cleanup, repair, refreeze, update_date_ranges
    params: dict[str, Any] = Field(default_factory=dict)
    cron: str | None = None  # cron expression (e.g., "0 2 1 * *")
    interval_seconds: int | None = None  # alternative: run every N seconds


class AuthTokenConfig(BaseModel):
    """A configured API token with associated roles."""

    name: str
    token: str
    roles: list[str] = Field(default_factory=lambda: ["admin"])


class TLSConfig(BaseModel):
    """TLS certificate configuration."""

    cert: str  # path to certificate file
    key: str  # path to private key file


class AuthConfig(BaseModel):
    """Authentication configuration."""

    tokens: list[AuthTokenConfig] = Field(default_factory=list)


class ServerConfig(BaseModel):
    """Top-level server configuration."""

    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: list[str] = Field(default_factory=lambda: ["*"])
    refresh_interval: float = 30.0
    scheduled_jobs: list[ScheduledJobConfig] = Field(default_factory=list)
    auth: AuthConfig = Field(default_factory=AuthConfig)
    tls: TLSConfig | None = None


def load_server_config(config_path: str | None = None) -> tuple[ServerConfig, dict[str, Any]]:
    """Load config from YAML, returning (server_config, raw_config_dict).

    The raw dict is passed to deepfreeze-core for ES client creation.
    Environment variables override YAML values:
        DEEPFREEZE_HOST, DEEPFREEZE_PORT, DEEPFREEZE_CORS_ORIGINS
    """
    raw: dict[str, Any] = {}
    path = config_path or (str(DEFAULT_CONFIG_PATH) if DEFAULT_CONFIG_PATH.is_file() else None)

    if path:
        try:
            with open(path) as f:
                raw = yaml.safe_load(f) or {}
            logger.info("Loaded config from %s", path)
        except Exception as e:
            print(f"ERROR: Failed to load config from {path}: {e}", file=sys.stderr)
            sys.exit(1)

    server_section = raw.get("server", {})
    # Parse scheduled jobs from config
    raw_jobs = server_section.get("scheduled_jobs", [])
    scheduled_jobs = []
    for j in raw_jobs:
        if isinstance(j, dict) and "name" in j and "action" in j:
            scheduled_jobs.append(ScheduledJobConfig(**j))

    # Parse auth config
    raw_auth = server_section.get("auth", {})
    auth_tokens = []
    for t in raw_auth.get("tokens", []):
        if isinstance(t, dict) and "name" in t and "token" in t:
            auth_tokens.append(AuthTokenConfig(**t))
    auth_config = AuthConfig(tokens=auth_tokens)

    # Parse TLS config
    tls_config = None
    raw_tls = server_section.get("tls", {})
    if raw_tls.get("cert") and raw_tls.get("key"):
        tls_config = TLSConfig(cert=raw_tls["cert"], key=raw_tls["key"])

    server = ServerConfig(
        host=os.environ.get("DEEPFREEZE_HOST", server_section.get("host", "0.0.0.0")),
        port=int(os.environ.get("DEEPFREEZE_PORT", server_section.get("port", 8000))),
        cors_origins=server_section.get("cors_origins", ["*"]),
        refresh_interval=float(server_section.get("refresh_interval", 30.0)),
        scheduled_jobs=scheduled_jobs,
        auth=auth_config,
        tls=tls_config,
    )

    return server, raw


def get_elasticsearch_config(raw_config: dict[str, Any]) -> dict[str, Any]:
    """Extract Elasticsearch connection config from raw YAML dict.

    Tries the deepfreeze CLI config loader first (for full compatibility),
    falls back to manual extraction.
    """
    try:
        from deepfreeze.config import get_elasticsearch_config as cli_get_es_config
        return cli_get_es_config(raw_config)
    except ImportError:
        pass

    # Manual fallback: extract ES config from known YAML keys
    es = raw_config.get("elasticsearch", {})
    result: dict[str, Any] = {}
    if "hosts" in es:
        result["hosts"] = es["hosts"]
    if "cloud_id" in es:
        result["cloud_id"] = es["cloud_id"]
    if "api_key" in es:
        result["api_key"] = es["api_key"]
    if "username" in es:
        result["basic_auth"] = (es["username"], es.get("password", ""))
    if "ca_certs" in es:
        result["ca_certs"] = es["ca_certs"]
    if "verify_certs" in es:
        result["verify_certs"] = es["verify_certs"]
    return result
