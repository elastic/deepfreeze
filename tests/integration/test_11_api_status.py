"""Server status API tests."""

import pytest

pytestmark = [pytest.mark.integration, pytest.mark.api]


class TestStatusAPI:
    """Status endpoints via httpx."""

    def test_get_full_status(self, http_client):
        """GET /status returns all sections."""
        resp = http_client.get("/status")
        assert resp.status_code == 200
        data = resp.json()
        assert "cluster" in data
        assert "repositories" in data
        assert "thaw_requests" in data
        assert "initialized" in data

    def test_get_repositories(self, http_client):
        """GET /status/repositories returns repo list."""
        resp = http_client.get("/status/repositories")
        assert resp.status_code == 200
        data = resp.json()
        assert "repositories" in data
        assert isinstance(data["repositories"], list)

    def test_get_thaw_requests(self, http_client):
        """GET /status/thaw-requests returns request list."""
        resp = http_client.get("/status/thaw-requests")
        assert resp.status_code == 200
        data = resp.json()
        assert "thaw_requests" in data

    def test_get_buckets(self, http_client):
        """GET /status/buckets returns bucket list."""
        resp = http_client.get("/status/buckets")
        assert resp.status_code == 200
        data = resp.json()
        assert "buckets" in data

    def test_get_ilm_policies(self, http_client):
        """GET /status/ilm-policies returns policy list."""
        resp = http_client.get("/status/ilm-policies")
        assert resp.status_code == 200
        data = resp.json()
        assert "ilm_policies" in data
