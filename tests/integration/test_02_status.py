"""Status verification tests — confirm status output after setup."""

import json

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


class TestStatusCLI:
    """Status command via CliRunner — all assertions use --porcelain."""

    def test_status_exits_zero(self, runner, test_config_file):
        """Status command should succeed."""
        result = runner.invoke(cli, [
            "--config", test_config_file,
            "--local",
            "status", "--porcelain",
        ])
        assert result.exit_code == 0, f"Status failed:\n{result.output}"

    def test_status_porcelain_parseable(self, runner, test_config_file):
        """Porcelain output should be valid JSON with expected keys."""
        result = runner.invoke(cli, [
            "--config", test_config_file,
            "--local",
            "status", "--porcelain",
        ])
        assert result.exit_code == 0, f"Status --porcelain failed:\n{result.output}"
        data = json.loads(result.output.strip())
        assert "settings" in data
        assert "repositories" in data
        assert "thaw_requests" in data

    def test_status_shows_repos(self, runner, test_config_file, test_prefixes):
        """Status should show repositories with the test prefix."""
        result = runner.invoke(cli, [
            "--config", test_config_file,
            "--local",
            "status", "--porcelain",
        ])
        assert result.exit_code == 0
        data = json.loads(result.output)
        repos = data.get("repositories", [])
        matching = [r for r in repos if r.get("name", "").startswith(test_prefixes.repo_name_prefix)]
        assert len(matching) > 0, (
            f"Expected at least one repo with prefix '{test_prefixes.repo_name_prefix}'. "
            f"Got: {[r.get('name') for r in repos]}"
        )
