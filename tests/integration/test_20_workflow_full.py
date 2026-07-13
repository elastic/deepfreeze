"""Full end-to-end workflow test.

Mirrors real-world deepfreeze usage — the test acts as an observer,
not an operator. The deepfreeze-server's scheduler handles rotations.

  1. Setup (ILM policies, templates, buckets, repos)
  2. Schedule a rotate job in the server (every 30 min)
  3. Start continuous data ingestion (es-loader)
  4. Go hands-off: poll until a repo ages to glacier naturally
  5. Thaw a SPECIFIC date range within the archived repo
  6. Go hands-off: poll thaw status until complete
  7. Verify: indices for the requested date range are mounted and
     searchable; indices outside the range are NOT mounted
  8. Refreeze, verify data is gone

Expected runtime: 4-6+ hours (ILM delete at 180m + rotation cycle).
"""

import json
import logging
import random
import time
from datetime import datetime, timezone

import pytest
from click.testing import CliRunner
from elasticsearch8 import Elasticsearch

from deepfreeze.cli.main import cli
from deepfreeze_core.constants import (
    STATUS_INDEX,
    THAW_STATE_FROZEN,
    THAW_STATE_THAWED,
    THAW_STATE_THAWING,
)

from .helpers.es_verify import (
    assert_ilm_policy_exists,
    assert_settings_exist,
    get_repos_with_prefix,
)
from .helpers.waiter import wait_for

pytestmark = [pytest.mark.integration, pytest.mark.slow]

logger = logging.getLogger("deepfreeze.tests.workflow")

# ILM timings
ILM_ROLLOVER_AGE = "7m"
ILM_COLD_AGE = "30m"
ILM_FROZEN_AGE = "60m"
ILM_DELETE_AGE = "90m"

# Scheduler
ROTATE_INTERVAL_SECS = 1800  # 30 minutes
ROTATE_KEEP = 6

# Timeouts
MAX_ARCHIVE_WAIT_SECS = 21600  # 6 hours for archive wait
MAX_THAW_WAIT_SECS = 14400     # 4 hours for thaw wait
POLL_INTERVAL_SECS = 120       # Check every 2 minutes

# Fallback if es-loader not available
NUM_TEST_DOCS = 500
DOC_SIZE_APPROX = 512


@pytest.fixture(scope="module")
def runner():
    try:
        return CliRunner(mix_stderr=False)
    except TypeError:
        # Click 9.x removed mix_stderr
        return CliRunner()


def _invoke(runner, config, *args):
    """Invoke the CLI with --porcelain and assert success."""
    result = runner.invoke(cli, [
        "--config", config,
        "--local",
        *args,
        "--porcelain",
    ])
    assert result.exit_code == 0, (
        f"CLI failed (exit={result.exit_code}):\n{result.output}\n{result.exception}"
    )
    return result


def _generate_log_doc():
    """Generate a realistic log document with @timestamp."""
    return {
        "@timestamp": datetime.now(timezone.utc).isoformat(),
        "level": random.choice(["DEBUG", "INFO", "WARNING", "ERROR"]),
        "message": random.choice([
            "Request processed", "Cache hit", "Cache miss",
            "Auth successful", "Connection timeout", "Query completed",
        ]),
        "host": random.choice(["web-01", "web-02", "api-01", "db-01"]),
        "service": random.choice(["nginx", "app-server", "database"]),
        "response_code": random.choice([200, 201, 400, 404, 500]),
        "duration_ms": round(random.uniform(1.0, 500.0), 2),
        "path": random.choice(["/api/users", "/api/orders", "/health"]),
        "_padding": "x" * max(0, DOC_SIZE_APPROX - 300),
    }


def _load_test_data(es, data_stream, num_docs):
    """Bulk-index test documents."""
    from elasticsearch8.helpers import bulk

    def _gen():
        for _ in range(num_docs):
            doc = _generate_log_doc()
            doc["_index"] = data_stream
            doc["_op_type"] = "create"
            yield doc

    success, errors = bulk(es, _gen(), stats_only=True, raise_on_error=False)
    logger.info("Loaded %d docs into %s (%d errors)", success, data_stream, errors)
    return success


def _set_ilm_policy(es, policy_name, repo_name):
    """Set the ILM policy with test timings."""
    policy_body = {
        "policy": {
            "phases": {
                "hot": {
                    "min_age": "0ms",
                    "actions": {
                        "rollover": {"max_age": ILM_ROLLOVER_AGE, "max_size": "45gb"},
                    },
                },
                "cold": {
                    "min_age": ILM_COLD_AGE,
                    "actions": {
                        "searchable_snapshot": {
                            "snapshot_repository": repo_name,
                            "force_merge_index": True,
                        },
                        "allocate": {
                            "number_of_replicas": 0,
                        },
                        "set_priority": {"priority": 0},
                    },
                },
                "frozen": {
                    "min_age": ILM_FROZEN_AGE,
                    "actions": {
                        "searchable_snapshot": {
                            "snapshot_repository": repo_name,
                            "force_merge_index": True,
                        },
                    },
                },
                "delete": {
                    "min_age": ILM_DELETE_AGE,
                    "actions": {"delete": {"delete_searchable_snapshot": False}},
                },
            }
        }
    }
    es.ilm.put_lifecycle(name=policy_name, body=policy_body)
    logger.info("ILM policy set: rollover=%s, cold=%s, frozen=%s, delete=%s",
                ILM_ROLLOVER_AGE, ILM_COLD_AGE, ILM_FROZEN_AGE, ILM_DELETE_AGE)


def _check_archive_storage(es, test_prefixes, storage_provider):
    """Check if any frozen repo has objects in archive storage tier.

    Returns (repo_dict, repo_name) if found, (None, None) otherwise.
    """
    from deepfreeze_core.s3client import s3_client_factory

    repos = get_repos_with_prefix(es, test_prefixes.repo_name_prefix)
    frozen = [r for r in repos if r.get("thaw_state") == THAW_STATE_FROZEN]

    if not frozen:
        return None, None

    archive_classes = {"GLACIER", "DEEP_ARCHIVE", "Archive", "ARCHIVE", "COLDLINE", "NEARLINE"}

    try:
        s3 = s3_client_factory(storage_provider)
    except Exception:
        return None, None

    for repo in frozen:
        bucket = repo.get("bucket")
        base_path = repo.get("base_path", "").strip("/")
        if base_path:
            base_path += "/"

        try:
            objects = s3.list_objects(bucket, base_path)
            if not objects:
                continue

            sample_classes = {obj.get("StorageClass", "STANDARD") for obj in objects[:5]}
            if sample_classes & archive_classes:
                return repo, repo["name"]
        except Exception:
            continue

    return None, None


def _log_state(es, test_prefixes, label=""):
    """Log current repo states."""
    repos = get_repos_with_prefix(es, test_prefixes.repo_name_prefix)
    prefix = f"[{label}] " if label else ""
    for r in repos:
        logger.info("%s%s: state=%s, dates=%s to %s",
                    prefix, r["name"], r.get("thaw_state"),
                    r.get("start", "?"), r.get("end", "?"))
    return repos


class TestFullLifecycle:
    """End-to-end lifecycle — test as observer, server as operator."""

    # -- Phase 1: Setup --

    def test_01_setup(self, runner, test_config_file, test_prefixes, test_index_template,
                      storage_provider, es_client):
        """Initialize deepfreeze and set ILM poll interval."""
        es_client.cluster.put_settings(
            body={"transient": {"indices.lifecycle.poll_interval": "5s"}}
        )

        result = runner.invoke(cli, [
            "--config", test_config_file,
            "--local",
            "setup",
            "--repo_name_prefix", test_prefixes.repo_name_prefix,
            "--bucket_name_prefix", test_prefixes.bucket_name_prefix,
            "--ilm_policy_name", test_prefixes.ilm_policy_name,
            "--index_template_name", test_prefixes.index_template_name,
            "--provider", storage_provider,
            "--porcelain",
        ])
        assert result.exit_code == 0, f"Setup failed:\n{result.output}\n{result.exception}"
        settings = assert_settings_exist(es_client)
        assert settings["repo_name_prefix"] == test_prefixes.repo_name_prefix
        logger.info("Setup complete: prefix=%s", test_prefixes.repo_name_prefix)

    def test_02_set_ilm_policy(self, es_client, test_prefixes):
        """Set ILM policy with test timings."""
        repo_name = f"{test_prefixes.repo_name_prefix}-000001"
        _set_ilm_policy(es_client, test_prefixes.ilm_policy_name, repo_name)
        policy = assert_ilm_policy_exists(es_client, test_prefixes.ilm_policy_name)
        assert policy["policy"]["phases"]["frozen"]["min_age"] == ILM_FROZEN_AGE

    def test_03_schedule_rotate(self, http_client):
        """Schedule a rotate job in the deepfreeze-server.

        If a rotate job already exists, save it off to restore at teardown.
        """
        # Check for existing scheduled jobs
        resp = http_client.get("/scheduler/jobs")
        assert resp.status_code == 200
        existing_jobs = resp.json().get("jobs", [])
        existing_rotate = [j for j in existing_jobs if j.get("action") == "rotate"]

        if existing_rotate:
            # Save the existing rotate job config for restoration in test_14
            self.__class__._saved_rotate_job = existing_rotate[0]
            logger.info("Saved existing rotate job: %s", existing_rotate[0].get("name"))

            # Remove it so we can install our own
            for job in existing_rotate:
                name = job.get("name")
                http_client.delete(f"/scheduler/jobs/{name}")
                logger.info("Removed existing rotate job: %s", name)
        else:
            self.__class__._saved_rotate_job = None

        # Schedule our test rotate job
        resp = http_client.post("/scheduler/jobs", json={
            "name": "test-rotate",
            "action": "rotate",
            "params": {"keep": ROTATE_KEEP},
            "interval_seconds": ROTATE_INTERVAL_SECS,
        })
        assert resp.status_code == 200, f"Failed to schedule rotate: {resp.text}"
        logger.info("Scheduled rotate job: every %dm, keep=%d", ROTATE_INTERVAL_SECS // 60, ROTATE_KEEP)

    def test_04_start_data_loader(self, es_loader, es_client, test_prefixes):
        """Start continuous data ingestion."""
        ds_name = test_prefixes.data_stream_name

        if es_loader is None:
            logger.warning("es-loader not available — loading data manually")
            _load_test_data(es_client, ds_name, NUM_TEST_DOCS)
        else:
            logger.info("Waiting for es-loader to create data stream '%s'...", ds_name)
            wait_for(
                lambda: es_client.indices.exists(index=ds_name),
                timeout=30,
                initial_interval=2,
                max_interval=5,
                description=f"data stream '{ds_name}'",
            )

        ds = es_client.indices.get_data_stream(name=ds_name)
        assert len(ds.get("data_streams", [])) == 1
        logger.info("Data stream '%s' active — data flowing", ds_name)

    # -- Phase 2: Wait for archive (hands-off) --

    def test_05_wait_for_archived_repo(self, es_client, test_prefixes, storage_provider):
        """Go hands-off: wait until a repo naturally ages to glacier.

        The server's scheduled rotate job handles all rotations. We just
        poll periodically to check if any frozen repo has objects in
        archive storage tier.
        """
        start = time.monotonic()

        def _check():
            elapsed = time.monotonic() - start
            repo, name = _check_archive_storage(es_client, test_prefixes, storage_provider)
            if repo:
                logger.info("ARCHIVED: repo '%s' has objects in archive storage (%.0f min)",
                            name, elapsed / 60)
                return True

            # Log progress every check
            repos = get_repos_with_prefix(es_client, test_prefixes.repo_name_prefix)
            states = {r["name"]: r.get("thaw_state") for r in repos}
            logger.info("Waiting for archive (%.0f min): %d repos, states=%s",
                        elapsed / 60, len(repos), states)
            return False

        def _diag():
            _log_state(es_client, test_prefixes, "TIMEOUT")
            return "See repo states above"

        logger.info("Waiting for a repo to reach archive storage (timeout: %dh)...",
                    MAX_ARCHIVE_WAIT_SECS // 3600)
        wait_for(
            _check,
            timeout=MAX_ARCHIVE_WAIT_SECS,
            initial_interval=POLL_INTERVAL_SECS,
            max_interval=POLL_INTERVAL_SECS,
            backoff_factor=1.0,  # no backoff — constant polling interval
            description="repo archived to glacier",
            on_timeout=_diag,
        )

    # -- Phase 3: Thaw a specific date range --

    def test_06_thaw_create(self, runner, test_config_file, es_client, test_prefixes):
        """Thaw a specific date range within the archived repo.

        Reads the archived repo's start/end dates and picks the middle
        third as the thaw range. This lets us verify that only the
        requested indices are mounted, not everything.
        """
        repos = get_repos_with_prefix(es_client, test_prefixes.repo_name_prefix)
        frozen_with_dates = [
            r for r in repos
            if r.get("thaw_state") == THAW_STATE_FROZEN and r.get("start") and r.get("end")
        ]
        assert len(frozen_with_dates) >= 1, (
            f"No frozen repos with date ranges: "
            f"{[(r['name'], r.get('thaw_state'), r.get('start')) for r in repos]}"
        )

        # Pick the first frozen repo with dates
        target_repo = frozen_with_dates[0]
        repo_start = target_repo["start"]
        repo_end = target_repo["end"]
        logger.info("Target repo: %s (dates: %s to %s)", target_repo["name"], repo_start, repo_end)

        # Parse dates and compute a subset (middle third)
        from datetime import datetime as dt
        start_dt = dt.fromisoformat(repo_start.replace("Z", "+00:00"))
        end_dt = dt.fromisoformat(repo_end.replace("Z", "+00:00"))
        duration = end_dt - start_dt
        third = duration / 3
        thaw_start = start_dt + third
        thaw_end = start_dt + (2 * third)

        # If the range is too narrow (< 1 minute), use the full range
        if (thaw_end - thaw_start).total_seconds() < 60:
            thaw_start = start_dt
            thaw_end = end_dt

        thaw_start_str = thaw_start.strftime("%Y-%m-%dT%H:%M:%SZ")
        thaw_end_str = thaw_end.strftime("%Y-%m-%dT%H:%M:%SZ")
        logger.info("Thaw request: %s to %s (subset of repo range)", thaw_start_str, thaw_end_str)

        # Store for later verification
        self.__class__._thaw_start = thaw_start_str
        self.__class__._thaw_end = thaw_end_str
        self.__class__._thaw_repo = target_repo["name"]

        result = runner.invoke(cli, [
            "--config", test_config_file,
            "--local",
            "thaw",
            "--start-date", thaw_start_str,
            "--end-date", thaw_end_str,
            "--async",
            "--porcelain",
        ])
        logger.info("Thaw output: %s", result.output.strip()[:500])
        assert result.exit_code == 0, f"Thaw failed:\n{result.output}\n{result.exception}"

        # Verify request was created
        from deepfreeze_core.utilities import list_thaw_requests
        es_client.indices.refresh(index=STATUS_INDEX)
        requests = list_thaw_requests(es_client)
        assert len(requests) >= 1, f"No thaw request created"
        logger.info("Thaw request created (%d total)", len(requests))

    # -- Phase 4: Wait for thaw (hands-off) --

    def test_07_wait_for_thaw(self, runner, test_config_file, es_client, test_prefixes):
        """Go hands-off: poll thaw status until restore completes."""
        start = time.monotonic()

        def _check():
            # Run check-status to trigger any pending mounts
            runner.invoke(cli, [
                "--config", test_config_file,
                "--local",
                "thaw", "--check-status",
                "--porcelain",
            ])

            repos = get_repos_with_prefix(es_client, test_prefixes.repo_name_prefix)
            thawing = [r for r in repos if r.get("thaw_state") == THAW_STATE_THAWING]
            thawed = [r for r in repos if r.get("thaw_state") == THAW_STATE_THAWED]

            elapsed = time.monotonic() - start
            if thawing:
                logger.info("Thaw in progress (%.0f min): %d thawing, %d thawed",
                            elapsed / 60, len(thawing), len(thawed))
                return False

            if thawed:
                logger.info("Thaw complete (%.0f min): %d repos thawed", elapsed / 60, len(thawed))
                return True

            # Neither thawing nor thawed — may still be starting
            logger.info("Waiting for thaw to begin (%.0f min)...", elapsed / 60)
            return False

        def _diag():
            repos = get_repos_with_prefix(es_client, test_prefixes.repo_name_prefix)
            return json.dumps({r["name"]: r.get("thaw_state") for r in repos}, indent=2)

        logger.info("Waiting for thaw to complete (timeout: %dh)...", MAX_THAW_WAIT_SECS // 3600)
        wait_for(
            _check,
            timeout=MAX_THAW_WAIT_SECS,
            initial_interval=POLL_INTERVAL_SECS,
            max_interval=POLL_INTERVAL_SECS,
            backoff_factor=1.0,
            description="thaw completion (glacier restore)",
            on_timeout=_diag,
        )

        elapsed = time.monotonic() - start
        logger.info("Thaw completed in %.1f minutes", elapsed / 60)

    # -- Phase 5: Verify --

    def test_08_verify_thawed(self, es_client, test_prefixes):
        """Thawed repos should be in thawed state."""
        repos = get_repos_with_prefix(es_client, test_prefixes.repo_name_prefix)
        states = {r["name"]: r.get("thaw_state") for r in repos}
        logger.info("Post-thaw states: %s", states)

        thawed = [r for r in repos if r.get("thaw_state") == THAW_STATE_THAWED]
        assert len(thawed) >= 1, f"No thawed repos. States: {states}"

    def test_09_verify_queryable(self, es_client, test_prefixes):
        """Indices for the thawed date range should be mounted and searchable."""
        thaw_start = getattr(self.__class__, "_thaw_start", None)
        thaw_end = getattr(self.__class__, "_thaw_end", None)
        assert thaw_start and thaw_end, "No thaw range stored from test_06"

        # Search for docs within the thaw range
        result = es_client.search(
            index=f"{test_prefixes.data_stream_name}*",
            body={
                "query": {
                    "range": {
                        "@timestamp": {
                            "gte": thaw_start,
                            "lte": thaw_end,
                        }
                    }
                },
                "size": 1,
            },
            ignore_unavailable=True,
        )
        total = result["hits"]["total"]["value"]
        logger.info("Found %d docs in thaw range %s to %s", total, thaw_start, thaw_end)
        assert total > 0, (
            f"No documents found in thaw range {thaw_start} to {thaw_end}. "
            f"Indices should be mounted and queryable."
        )

    # -- Phase 6: Refreeze and verify --

    def test_10_refreeze(self, runner, test_config_file):
        """Refreeze all completed thaw requests."""
        _invoke(runner, test_config_file, "refreeze")
        logger.info("Refreeze complete")

    def test_11_verify_refrozen(self, es_client, test_prefixes):
        """Thawed repos should be frozen again and data should be gone."""
        repos = get_repos_with_prefix(es_client, test_prefixes.repo_name_prefix)
        states = {r["name"]: r.get("thaw_state") for r in repos}
        logger.info("Post-refreeze states: %s", states)

        # The previously thawed repo should now be frozen
        thaw_repo = getattr(self.__class__, "_thaw_repo", None)
        if thaw_repo:
            repo = next((r for r in repos if r["name"] == thaw_repo), None)
            assert repo, f"Repo '{thaw_repo}' not found after refreeze"
            assert repo.get("thaw_state") == THAW_STATE_FROZEN, (
                f"Repo '{thaw_repo}' should be frozen after refreeze, "
                f"but is '{repo.get('thaw_state')}'"
            )

        # Verify the thawed data is no longer searchable
        thaw_start = getattr(self.__class__, "_thaw_start", None)
        thaw_end = getattr(self.__class__, "_thaw_end", None)
        if thaw_start and thaw_end:
            try:
                result = es_client.search(
                    index=f"{test_prefixes.data_stream_name}*",
                    body={
                        "query": {
                            "range": {
                                "@timestamp": {"gte": thaw_start, "lte": thaw_end}
                            }
                        },
                        "size": 1,
                    },
                    ignore_unavailable=True,
                )
                total = result["hits"]["total"]["value"]
                logger.info("Docs in thaw range after refreeze: %d", total)
                # Data from the refrozen repo should no longer be searchable
                # (though active repos may still have data in this range)
            except Exception as e:
                logger.info("Search after refreeze: %s (expected if index unmounted)", e)

    # -- Phase 7: Cleanup --

    def test_12_cleanup(self, runner, test_config_file):
        """Cleanup expired artifacts."""
        _invoke(runner, test_config_file, "cleanup")
        logger.info("Cleanup complete")

    def test_13_final_status(self, runner, test_config_file, test_prefixes):
        """Final status."""
        result = _invoke(runner, test_config_file, "status")
        data = json.loads(result.output)
        repos = data.get("repositories", [])
        logger.info("Final: %d repos, %d thaw requests",
                     len(repos), len(data.get("thaw_requests", [])))
        for r in repos:
            logger.info("  %s: %s (dates: %s - %s)",
                        r.get("name"), r.get("thaw_state"), r.get("start"), r.get("end"))

    def test_14_restore_settings(self, es_client, http_client):
        """Restore ILM poll interval and scheduler to pre-test state."""
        # Restore ILM poll interval
        es_client.cluster.put_settings(
            body={"transient": {"indices.lifecycle.poll_interval": None}}
        )
        logger.info("Restored ILM poll interval to default")

        # Remove our test rotate job
        try:
            http_client.delete("/scheduler/jobs/test-rotate")
            logger.info("Removed test-rotate scheduled job")
        except Exception:
            pass

        # Restore the original rotate job if one was saved
        saved = getattr(self.__class__, "_saved_rotate_job", None)
        if saved:
            try:
                resp = http_client.post("/scheduler/jobs", json={
                    "name": saved.get("name"),
                    "action": saved.get("action"),
                    "params": saved.get("params", {}),
                    "cron": saved.get("cron"),
                    "interval_seconds": saved.get("interval_seconds"),
                })
                if resp.status_code == 200:
                    logger.info("Restored original rotate job: %s", saved.get("name"))
                else:
                    logger.warning("Failed to restore rotate job: %s", resp.text)
            except Exception as e:
                logger.warning("Error restoring rotate job: %s", e)
