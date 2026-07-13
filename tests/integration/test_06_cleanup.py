"""Cleanup workflow tests."""

import pytest
from click.testing import CliRunner

from deepfreeze.cli.main import cli

pytestmark = [pytest.mark.integration, pytest.mark.cli]


@pytest.fixture
def runner():
    try:
        return CliRunner(mix_stderr=False)
    except TypeError:
        return CliRunner()


class TestCleanupCLI:
    """Cleanup command via CliRunner — uses --porcelain for output."""

    def test_cleanup_dry_run(self, runner, test_config_file):
        """Cleanup --dry-run should exit 0."""
        result = runner.invoke(cli, [
            "--config", test_config_file,
            "--local", "--dry-run",
            "cleanup", "--porcelain",
        ])
        assert result.exit_code == 0, f"Cleanup dry-run failed:\n{result.output}\n{result.exception}"

    def test_cleanup_runs(self, runner, test_config_file):
        """Cleanup should complete without error."""
        result = runner.invoke(cli, [
            "--config", test_config_file,
            "--local",
            "cleanup", "--porcelain",
        ])
        assert result.exit_code == 0, f"Cleanup failed:\n{result.output}\n{result.exception}"
