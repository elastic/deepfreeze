"""HTTP client for communicating with a remote deepfreeze-server."""

from typing import Any

import httpx


class DeepfreezeClient:
    """Thin HTTP client that talks to the deepfreeze-server REST API.

    Used by the CLI when a server URL is configured (remote mode).
    """

    def __init__(
        self,
        server_url: str,
        api_token: str | None = None,
        timeout: float = 120.0,
    ) -> None:
        self.base_url = server_url.rstrip("/")
        headers = {"Content-Type": "application/json"}
        if api_token:
            headers["Authorization"] = f"Bearer {api_token}"
        self._client = httpx.Client(
            base_url=self.base_url,
            headers=headers,
            timeout=timeout,
        )

    def close(self) -> None:
        self._client.close()

    # -- Status endpoints --

    def get_status(self, force_refresh: bool = False) -> dict[str, Any]:
        r = self._client.get("/api/status", params={"force_refresh": force_refresh})
        r.raise_for_status()
        return r.json()

    def get_cluster_health(self) -> dict[str, Any]:
        r = self._client.get("/api/status/cluster")
        r.raise_for_status()
        return r.json()

    def get_repositories(self) -> list[dict]:
        r = self._client.get("/api/status/repositories")
        r.raise_for_status()
        return r.json().get("repositories", [])

    def get_thaw_requests(self) -> list[dict]:
        r = self._client.get("/api/status/thaw-requests")
        r.raise_for_status()
        return r.json().get("thaw_requests", [])

    def get_buckets(self) -> list[dict]:
        r = self._client.get("/api/status/buckets")
        r.raise_for_status()
        return r.json().get("buckets", [])

    def get_ilm_policies(self) -> list[dict]:
        r = self._client.get("/api/status/ilm-policies")
        r.raise_for_status()
        return r.json().get("ilm_policies", [])

    def get_history(self, limit: int = 25) -> list[dict]:
        r = self._client.get("/api/history", params={"limit": limit})
        r.raise_for_status()
        return r.json().get("history", [])

    def get_audit_log(self, limit: int = 50, action: str | None = None) -> dict:
        params: dict = {"limit": limit}
        if action:
            params["action"] = action
        r = self._client.get("/api/audit", params=params)
        r.raise_for_status()
        return r.json()

    def get_restore_progress(self, request_id: str) -> dict:
        r = self._client.get(f"/api/thaw-requests/{request_id}/restore-progress")
        r.raise_for_status()
        return r.json()

    # -- Action endpoints --
    # All actions use ?wait=true by default so the CLI gets a synchronous result.

    def rotate(
        self,
        year: int | None = None,
        month: int | None = None,
        keep: int = 6,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        return self._post_action("/api/actions/rotate", {
            "year": year,
            "month": month,
            "keep": keep,
            "dry_run": dry_run,
        })

    def thaw_create(
        self,
        start_date: str,
        end_date: str,
        duration: int = 30,
        tier: str = "Standard",
        sync: bool = True,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        return self._post_action("/api/actions/thaw", {
            "start_date": start_date,
            "end_date": end_date,
            "duration": duration,
            "tier": tier,
            "sync": sync,
            "dry_run": dry_run,
        })

    def thaw_check(self, request_id: str | None = None) -> dict[str, Any]:
        return self._post_action("/api/actions/thaw/check", {
            "request_id": request_id,
        })

    def refreeze(
        self,
        request_id: str | None = None,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        return self._post_action("/api/actions/refreeze", {
            "request_id": request_id,
            "dry_run": dry_run,
        })

    def cleanup(
        self,
        refrozen_retention_days: int | None = None,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        return self._post_action("/api/actions/cleanup", {
            "refrozen_retention_days": refrozen_retention_days,
            "dry_run": dry_run,
        })

    def repair_metadata(self, dry_run: bool = False) -> dict[str, Any]:
        return self._post_action("/api/actions/repair", {
            "dry_run": dry_run,
        })

    def setup(
        self,
        repo_name_prefix: str = "deepfreeze",
        bucket_name_prefix: str = "deepfreeze",
        ilm_policy_name: str | None = None,
        index_template_name: str | None = None,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        return self._post_action("/api/actions/setup", {
            "repo_name_prefix": repo_name_prefix,
            "bucket_name_prefix": bucket_name_prefix,
            "ilm_policy_name": ilm_policy_name,
            "index_template_name": index_template_name,
            "dry_run": dry_run,
        })

    # -- Health --

    def health(self) -> dict[str, Any]:
        r = self._client.get("/health")
        r.raise_for_status()
        return r.json()

    def ready(self) -> dict[str, Any]:
        r = self._client.get("/ready")
        r.raise_for_status()
        return r.json()

    # -- Jobs --

    def list_jobs(self, status: str | None = None) -> list[dict]:
        params = {}
        if status:
            params["status"] = status
        r = self._client.get("/api/jobs", params=params)
        r.raise_for_status()
        return r.json().get("jobs", [])

    def get_job(self, job_id: str) -> dict:
        r = self._client.get(f"/api/jobs/{job_id}")
        r.raise_for_status()
        return r.json()

    def cancel_job(self, job_id: str) -> dict:
        r = self._client.delete(f"/api/jobs/{job_id}")
        r.raise_for_status()
        return r.json()

    # -- Internal --

    def _post_action(self, path: str, body: dict) -> dict[str, Any]:
        """POST an action with ?wait=true and return the result."""
        r = self._client.post(path, json=body, params={"wait": "true", "timeout": "120"})
        if r.status_code == 202:
            # Job still running after timeout
            return r.json()
        r.raise_for_status()
        return r.json()
