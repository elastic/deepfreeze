"""Server health and readiness endpoint tests."""

import pytest

pytestmark = [pytest.mark.integration, pytest.mark.api]


class TestHealthAPI:
    """Health and readiness via httpx."""

    def test_health(self, http_client):
        """GET /health returns 200."""
        resp = http_client.get("/health")
        # health endpoint is at root, not /api
        pass  # handled below

    def test_health_endpoint(self, server_url):
        """GET /health returns status ok."""
        import httpx

        resp = httpx.get(f"{server_url}/health", timeout=10)
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("status") == "ok"

    def test_ready_endpoint(self, server_url):
        """GET /ready returns readiness info."""
        import httpx

        resp = httpx.get(f"{server_url}/ready", timeout=10)
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("ready") is True
