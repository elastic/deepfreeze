"""Smoke tests — verify prerequisites before running the real suite."""

import pytest

pytestmark = [pytest.mark.integration]


class TestPrerequisites:
    """Fail fast if the test environment is not ready."""

    def test_es_connectivity(self, es_client):
        """Cluster is reachable and responds to ping."""
        assert es_client.ping(), "Elasticsearch cluster did not respond to ping"

    def test_cluster_health(self, es_client):
        """Cluster health is green or yellow."""
        health = es_client.cluster.health(timeout="10s")
        assert health["status"] in ("green", "yellow"), (
            f"Cluster health is '{health['status']}'"
        )

    def test_es_version(self, es_client):
        """Cluster is running ES 8.x+."""
        info = es_client.info()
        version = info["version"]["number"]
        major = int(version.split(".")[0])
        assert major >= 8, f"Elasticsearch {version} is not supported (need 8.x+)"

    def test_config_loaded(self, integration_config):
        """Config dict has an elasticsearch section."""
        assert "elasticsearch" in integration_config

    def test_storage_connectivity(self, storage_provider):
        """Storage provider client can connect."""
        try:
            from deepfreeze_core.s3client import s3_client_factory

            s3 = s3_client_factory(storage_provider)
        except (ImportError, ModuleNotFoundError) as e:
            pytest.skip(f"Storage SDK for '{storage_provider}' not installed: {e}")

        assert s3.test_connection(), (
            f"Storage provider '{storage_provider}' failed connection test"
        )

    def test_cluster_is_clean(self, es_client):
        """Cluster should not have a deepfreeze-status index (enforced by es_client fixture)."""
        from deepfreeze_core.constants import STATUS_INDEX
        assert not es_client.indices.exists(index=STATUS_INDEX), (
            f"'{STATUS_INDEX}' index exists — tests require a clean cluster"
        )
