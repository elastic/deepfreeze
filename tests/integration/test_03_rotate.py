"""Rotate workflow tests — verify repository creation and archival.

All repos are created with the dftest-{run_id} prefix.
"""

import pytest
from click.testing import CliRunner

from deepfreeze.cli.main import cli

from .helpers.es_verify import assert_repo_exists, get_repos_with_prefix

pytestmark = [pytest.mark.integration, pytest.mark.cli]


@pytest.fixture
def runner():
    try:
        return CliRunner(mix_stderr=False)
    except TypeError:
        return CliRunner()


class TestRotateCLI:
    """Rotate command via CliRunner — uses --porcelain for output."""

    def test_rotate_dry_run(self, runner, test_config_file, es_client, test_prefixes):
        """--dry-run should not create a new repository."""
        repos_before = get_repos_with_prefix(es_client, test_prefixes.repo_name_prefix)

        result = runner.invoke(cli, [
            "--config", test_config_file,
            "--local", "--dry-run",
            "rotate", "--porcelain",
        ])
        assert result.exit_code == 0, f"Rotate dry-run failed:\n{result.output}\n{result.exception}"

        repos_after = get_repos_with_prefix(es_client, test_prefixes.repo_name_prefix)
        assert len(repos_after) == len(repos_before), "Dry run should not create a repo"

    def test_rotate_creates_new_repo(self, runner, test_config_file, es_client, test_prefixes):
        """Rotate should create one additional repository."""
        repos_before = get_repos_with_prefix(es_client, test_prefixes.repo_name_prefix)
        count_before = len(repos_before)

        result = runner.invoke(cli, [
            "--config", test_config_file,
            "--local",
            "rotate", "--porcelain",
        ])
        assert result.exit_code == 0, f"Rotate failed:\n{result.output}\n{result.exception}"

        repos_after = get_repos_with_prefix(es_client, test_prefixes.repo_name_prefix)
        assert len(repos_after) == count_before + 1, (
            f"Expected {count_before + 1} repos after rotate, got {len(repos_after)}. "
            f"Before: {[r['name'] for r in repos_before]}  "
            f"After: {[r['name'] for r in repos_after]}"
        )

        # Verify the new repo exists as an ES snapshot repository
        expected = f"{test_prefixes.repo_name_prefix}-000002"
        assert_repo_exists(es_client, expected)

    def test_repo_states_after_rotate(self, runner, test_config_file, es_client, test_prefixes):
        """After rotation, at least one repo should be active."""
        repos = get_repos_with_prefix(es_client, test_prefixes.repo_name_prefix)
        states = [(r["name"], r.get("thaw_state", "unknown")) for r in repos]

        active = [r for r in repos if r.get("thaw_state") == "active"]
        assert len(active) >= 1, f"Expected at least one active repo. States: {states}"
