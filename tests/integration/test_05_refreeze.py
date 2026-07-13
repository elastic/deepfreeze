"""Refreeze workflow tests."""

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


class TestRefreezeCLI:
    """Refreeze command via CliRunner — uses --porcelain for output."""

    def test_refreeze_dry_run(self, runner, test_config_file):
        """Refreeze --dry-run should exit 0 without changing state."""
        result = runner.invoke(cli, [
            "--config", test_config_file,
            "--local", "--dry-run",
            "refreeze", "--porcelain",
        ])
        assert result.exit_code == 0, f"Refreeze dry-run failed:\n{result.output}\n{result.exception}"

    def test_refreeze_all(self, runner, test_config_file):
        """Refreeze all completed requests (may be a no-op if none are completed)."""
        result = runner.invoke(cli, [
            "--config", test_config_file,
            "--local",
            "refreeze", "--porcelain",
        ])
        assert result.exit_code == 0, f"Refreeze failed:\n{result.output}\n{result.exception}"
