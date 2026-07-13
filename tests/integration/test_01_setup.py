"""Setup workflow tests — initialize deepfreeze with test prefixes."""

import subprocess

import pytest
from click.testing import CliRunner

from deepfreeze.cli.main import cli

from .helpers.es_verify import (
    assert_ilm_policy_exists,
    assert_index_exists,
    assert_repo_exists,
    assert_settings_exist,
)

pytestmark = [pytest.mark.integration, pytest.mark.cli]


@pytest.fixture
def runner():
    try:
        return CliRunner(mix_stderr=False)
    except TypeError:
        return CliRunner()


def _setup_args(test_prefixes, storage_provider):
    """Build the CLI args list for a setup invocation."""
    return [
        "--repo_name_prefix", test_prefixes.repo_name_prefix,
        "--bucket_name_prefix", test_prefixes.bucket_name_prefix,
        "--ilm_policy_name", test_prefixes.ilm_policy_name,
        "--index_template_name", test_prefixes.index_template_name,
        "--provider", storage_provider,
        "--porcelain",
    ]


class TestSetupCLI:
    """Setup via Click's CliRunner (in-process)."""

    def test_setup_dry_run(self, runner, test_config_file, test_prefixes,
                           test_index_template, storage_provider, es_client):
        """--dry-run should exit 0 without creating artifacts."""
        result = runner.invoke(cli, [
            "--config", test_config_file,
            "--local", "--dry-run",
            "setup", *_setup_args(test_prefixes, storage_provider),
        ])
        assert result.exit_code == 0, f"Setup dry-run failed:\n{result.output}\n{result.exception}"

        # No status index should have been created
        from deepfreeze_core.constants import STATUS_INDEX
        assert not es_client.indices.exists(index=STATUS_INDEX), "Dry run created the status index"

    def test_setup_creates_artifacts(self, runner, test_config_file, test_prefixes,
                                     test_index_template, storage_provider, es_client):
        """Real setup should create status index, repo, ILM policy, and settings."""
        result = runner.invoke(cli, [
            "--config", test_config_file,
            "--local",
            "setup", *_setup_args(test_prefixes, storage_provider),
        ])
        assert result.exit_code == 0, f"Setup failed:\n{result.output}\n{result.exception}"

        # Verify status index
        assert_index_exists(es_client, "deepfreeze-status")

        # Verify settings doc with test prefixes
        settings = assert_settings_exist(es_client)
        assert settings["repo_name_prefix"] == test_prefixes.repo_name_prefix
        assert settings["bucket_name_prefix"] == test_prefixes.bucket_name_prefix
        assert settings["provider"] == storage_provider

        # Verify snapshot repository with test prefix
        expected_repo = f"{test_prefixes.repo_name_prefix}-000001"
        assert_repo_exists(es_client, expected_repo)

        # Verify ILM policy with test prefix
        assert_ilm_policy_exists(es_client, test_prefixes.ilm_policy_name)


class TestSetupSubprocess:
    """Setup via subprocess — validates the installed entry point."""

    def test_setup_help(self):
        """deepfreeze setup --help exits 0."""
        result = subprocess.run(
            ["deepfreeze", "setup", "--help"],
            capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0
        assert "Set up a cluster" in result.stdout or "setup" in result.stdout.lower()
