"""Server action API tests."""

import pytest

pytestmark = [pytest.mark.integration, pytest.mark.api]


class TestActionsAPI:
    """Action endpoints via httpx."""

    def test_rotate_dry_run(self, http_client):
        """POST /actions/rotate with dry_run=true."""
        resp = http_client.post(
            "/actions/rotate?wait=true",
            json={"dry_run": True},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("action") == "rotate"
        assert data.get("dry_run") is True

    def test_cleanup_dry_run(self, http_client):
        """POST /actions/cleanup with dry_run=true."""
        resp = http_client.post(
            "/actions/cleanup?wait=true",
            json={"dry_run": True},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("action") == "cleanup"

    def test_repair_dry_run(self, http_client):
        """POST /actions/repair with dry_run=true."""
        resp = http_client.post(
            "/actions/repair?wait=true",
            json={"dry_run": True},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("action") == "repairmetadata" or "repair" in data.get("action", "")

    def test_rotate_real(self, http_client):
        """POST /actions/rotate (real) should succeed."""
        resp = http_client.post(
            "/actions/rotate?wait=true&timeout=120",
            json={"dry_run": False},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("success") is True, f"Rotate failed: {data}"

    def test_async_job_submission(self, http_client):
        """POST without ?wait returns 202 with job_id."""
        resp = http_client.post(
            "/actions/cleanup?wait=false",
            json={"dry_run": True},
        )
        # 200 or 202 depending on whether the job completes instantly
        assert resp.status_code in (200, 202)
        data = resp.json()
        if resp.status_code == 202:
            assert "job_id" in data or "id" in data
