"""Thaw workflow tests — create thaw requests, check status, verify mounting."""

import pytest
from click.testing import CliRunner

from deepfreeze.cli.main import cli

pytestmark = [pytest.mark.integration, pytest.mark.cli, pytest.mark.slow]


@pytest.fixture
def runner():
    try:
        return CliRunner(mix_stderr=False)
    except TypeError:
        return CliRunner()


class TestThawCLI:
    """Thaw command via CliRunner — uses --porcelain for output."""

    def test_thaw_list(self, runner, test_config_file):
        """List thaw requests — should work even if no requests exist."""
        result = runner.invoke(cli, [
            "--config", test_config_file,
            "--local",
            "thaw", "--list", "--porcelain",
        ])
        assert result.exit_code == 0, f"Thaw --list failed:\n{result.output}"

    def test_thaw_create_request(self, runner, test_config_file):
        """Create a thaw request for a broad date range."""
        result = runner.invoke(cli, [
            "--config", test_config_file,
            "--local",
            "thaw",
            "--start-date", "2020-01-01T00:00:00Z",
            "--end-date", "2030-12-31T23:59:59Z",
            "--async",
            "--porcelain",
        ])
        assert result.exit_code == 0, f"Thaw create failed:\n{result.output}\n{result.exception}"

    def test_thaw_check_status(self, runner, test_config_file):
        """Check status of all thaw requests."""
        result = runner.invoke(cli, [
            "--config", test_config_file,
            "--local",
            "thaw", "--check-status", "--porcelain",
        ])
        assert result.exit_code == 0, f"Thaw --check-status failed:\n{result.output}"

    def test_thaw_dry_run(self, runner, test_config_file):
        """Thaw dry-run should not create a request."""
        result = runner.invoke(cli, [
            "--config", test_config_file,
            "--local", "--dry-run",
            "thaw",
            "--start-date", "2020-01-01T00:00:00Z",
            "--end-date", "2030-12-31T23:59:59Z",
            "--porcelain",
        ])
        assert result.exit_code == 0, f"Thaw dry-run failed:\n{result.output}\n{result.exception}"
