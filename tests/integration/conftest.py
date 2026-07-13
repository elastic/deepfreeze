"""Integration test fixtures.

These tests require a CLEAN Elasticsearch cluster — one where deepfreeze
has NOT been initialized (no ``deepfreeze-status`` index).  All artifacts
are created with a unique ``dftest-{run_id}`` prefix for isolation.

If the cluster already has a ``deepfreeze-status`` index, the session
fails immediately with instructions to use a fresh cluster.
"""

import logging
import os
import socket
import subprocess
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path

import pytest
import yaml

from deepfreeze_core.constants import STATUS_INDEX
from deepfreeze_core.esclient import create_es_client

from .helpers.diagnostics import write_failure_diagnostics
from .helpers.waiter import wait_for_server_ready

logger = logging.getLogger("deepfreeze.tests")


# ---------------------------------------------------------------------------
# Dataclass for test-run prefixes
# ---------------------------------------------------------------------------

@dataclass
class TestPrefixes:
    """All artifact names used by a single test run."""
    run_id: str
    repo_name_prefix: str
    bucket_name_prefix: str
    ilm_policy_name: str
    index_template_name: str
    data_stream_name: str


# ---------------------------------------------------------------------------
# Session fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def test_run_id():
    """Unique 6-char hex prefix for this test run."""
    return uuid.uuid4().hex[:6]


@pytest.fixture(scope="session")
def integration_config():
    """Load ES config from env var or default location."""
    config_path = os.environ.get("DEEPFREEZE_TEST_CONFIG")
    if not config_path:
        default = Path.home() / ".deepfreeze" / "config.yml"
        if default.is_file():
            config_path = str(default)

    if not config_path or not Path(config_path).is_file():
        pytest.skip("No ES config available (set DEEPFREEZE_TEST_CONFIG or create ~/.deepfreeze/config.yml)")

    with open(config_path) as f:
        config = yaml.safe_load(f) or {}

    if "elasticsearch" not in config:
        pytest.skip("Config file missing 'elasticsearch' section")

    return config


@pytest.fixture(scope="session")
def es_client(integration_config):
    """Real Elasticsearch client, validated on creation."""
    from deepfreeze.config import get_elasticsearch_config

    es_config = get_elasticsearch_config(integration_config)
    client = create_es_client(**es_config)

    # Validate connectivity
    health = client.cluster.health(timeout="10s")
    assert health["status"] in ("green", "yellow"), (
        f"Cluster health is '{health['status']}' — expected green or yellow"
    )
    logger.info("Connected to ES cluster: %s (status: %s)", health.get("cluster_name"), health["status"])

    # Fail fast if cluster is already initialized
    if client.indices.exists(index=STATUS_INDEX):
        pytest.fail(
            f"Cluster already has a '{STATUS_INDEX}' index. "
            f"Integration tests require a clean cluster to ensure full isolation. "
            f"Either use a fresh cluster or delete the index:\n"
            f"  curl -X DELETE '<host>:9200/{STATUS_INDEX}'\n"
            f"  curl -X DELETE '<host>:9200/deepfreeze-audit'"
        )

    yield client
    client.close()


@pytest.fixture(scope="session")
def storage_provider(integration_config):
    """The cloud storage provider."""
    env_provider = os.environ.get("DEEPFREEZE_TEST_PROVIDER")
    if env_provider:
        return env_provider

    storage = integration_config.get("storage", {})
    sdk_imports = {"aws": "boto3", "azure": "azure.storage.blob", "gcp": "google.cloud.storage"}
    for provider in ("aws", "gcp", "azure"):
        if provider in storage:
            try:
                __import__(sdk_imports[provider])
                return provider
            except ImportError:
                continue
    return "aws"


@pytest.fixture(scope="session")
def test_prefixes(test_run_id):
    """Artifact names keyed by this test run's unique prefix."""
    prefix = f"dftest-{test_run_id}"
    return TestPrefixes(
        run_id=test_run_id,
        repo_name_prefix=prefix,
        bucket_name_prefix=prefix,
        ilm_policy_name=f"{prefix}-ilm",
        index_template_name=f"{prefix}-tmpl",
        data_stream_name=f"{prefix}-data",
    )


@pytest.fixture(scope="session")
def test_config_file(integration_config, test_prefixes):
    """Temporary config YAML with real ES creds."""
    config = dict(integration_config)
    config.setdefault("logging", {})["loglevel"] = "DEBUG"

    fd, path = tempfile.mkstemp(suffix=".yml", prefix="dftest-config-")
    with os.fdopen(fd, "w") as f:
        yaml.safe_dump(config, f)

    logger.info("Test config written to %s (run_id=%s)", path, test_prefixes.run_id)
    yield path

    try:
        os.unlink(path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Index template fixture — creates a data stream template for setup
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def test_index_template(es_client, test_prefixes):
    """Create a data stream index template for the test run.

    Setup requires an existing index template to attach the ILM policy to.
    The template must have data_stream: {} for ILM rollover to work.
    """
    template_name = test_prefixes.index_template_name
    pattern = f"{test_prefixes.data_stream_name}*"

    es_client.indices.put_index_template(
        name=template_name,
        body={
            "index_patterns": [pattern],
            "data_stream": {},
            "template": {
                "settings": {"number_of_shards": 1, "number_of_replicas": 0},
            },
        },
    )
    logger.info("Created data stream template '%s' (pattern: %s)", template_name, pattern)
    yield template_name


# ---------------------------------------------------------------------------
# Background data loader (es-loader) — runs throughout the test session
# ---------------------------------------------------------------------------

ES_LOADER_PATH = Path(__file__).parent.parent.parent.parent / "deepfreeze-testing" / "es-loader" / "es-loader.py"


@pytest.fixture(scope="session")
def es_loader(integration_config, test_prefixes):
    """Start es-loader as a background process pushing data to the test data stream.

    Runs continuously at ~10 docs/sec throughout the test session, ensuring
    there's always fresh timestamped data flowing through ILM. Killed at teardown.

    Requires ~/git/deepfreeze-testing/es-loader/es-loader.py to exist.
    """
    if not ES_LOADER_PATH.is_file():
        logger.warning("es-loader not found at %s — skipping background data load", ES_LOADER_PATH)
        yield None
        return

    # Build an es-loader config file with the test cluster creds and data stream name
    es_section = integration_config.get("elasticsearch", {})
    loader_config = {
        "elasticsearch": {
            "hosts": es_section.get("hosts", []),
            "verify_certs": es_section.get("verify_certs", False),
            "ssl_show_warn": False,
            "timeout": 30,
            "max_retries": 3,
            "retry_on_timeout": True,
        },
        "index": {
            "name": test_prefixes.data_stream_name,
            "is_datastream": True,
        },
        "document": {"size": 512},
        "indexing": {"rate": 10, "bulk_size": 50, "num_docs": 0},
        "logging": {"level": "WARNING", "progress_interval": 60},
    }

    # Copy auth from the integration config
    if "api_key" in es_section:
        loader_config["elasticsearch"]["api_key"] = es_section["api_key"]
    elif "username" in es_section:
        loader_config["elasticsearch"]["auth"] = {
            "username": es_section["username"],
            "password": es_section.get("password", ""),
        }
    if "cloud_id" in es_section:
        loader_config["elasticsearch"]["cloud_id"] = es_section["cloud_id"]

    fd, config_path = tempfile.mkstemp(suffix=".yml", prefix="dftest-loader-")
    with os.fdopen(fd, "w") as f:
        yaml.safe_dump(loader_config, f)

    logger.info("Starting es-loader: %s -> %s (10 docs/sec)", ES_LOADER_PATH, test_prefixes.data_stream_name)
    proc = subprocess.Popen(
        ["python3", str(ES_LOADER_PATH), "-c", config_path, "-r", "10"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    logger.info("es-loader started (pid=%d)", proc.pid)

    yield proc

    # Teardown: kill the loader
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    logger.info("es-loader stopped")

    try:
        os.unlink(config_path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Server process fixture (for API and WebUI tests)
# ---------------------------------------------------------------------------

def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def server_url(test_config_file):
    """Connect to an existing server or start one on an ephemeral port.

    If DEEPFREEZE_SERVER_URL is set, use that (assume server is already
    running). Otherwise, start a new server process and stop it at teardown.
    """
    # Try DEEPFREEZE_SERVER_URL, then localhost:8000, then start a new server
    candidates = []
    env_url = os.environ.get("DEEPFREEZE_SERVER_URL")
    if env_url:
        candidates.append(env_url)
    candidates.append("http://localhost:8000")

    for url in candidates:
        try:
            wait_for_server_ready(url, timeout=5)
            logger.info("Using existing server at %s", url)
            yield url
            return
        except TimeoutError:
            logger.debug("Server at %s not reachable", url)

    # No existing server found — start one
    port = _find_free_port()
    proc = subprocess.Popen(
        [
            "deepfreeze-server",
            "--config", test_config_file,
            "--port", str(port),
            "--no-tls",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    base_url = f"http://localhost:{port}"
    try:
        wait_for_server_ready(base_url, timeout=30)
        logger.info("Test server running at %s (pid=%d)", base_url, proc.pid)
        yield base_url
    except TimeoutError:
        stderr = proc.stderr.read().decode() if proc.stderr else ""
        proc.kill()
        pytest.fail(f"Server failed to start within 30s. stderr:\n{stderr}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


@pytest.fixture(scope="session")
def http_client(server_url):
    """httpx client pointed at the test server."""
    import httpx

    with httpx.Client(base_url=f"{server_url}/api", timeout=30) as client:
        yield client


# ---------------------------------------------------------------------------
# Automatic cleanup (modeled after deepfreeze-testing/reset.sh)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session", autouse=True)
def auto_cleanup(es_client, test_prefixes, storage_provider):
    """Yield, then clean up ALL test artifacts on session teardown.

    Cleanup order follows reset.sh:
    1. Stop ILM
    2. Delete data streams
    3. Delete snapshot repositories
    4. Delete S3/Azure/GCS buckets
    5. Delete ILM policies
    6. Delete index templates
    7. Delete status and audit indices
    8. Delete any remaining indices matching prefix
    9. Restart ILM
    """
    yield

    prefix = test_prefixes.repo_name_prefix
    logger.info("=== Cleanup starting (prefix: %s) ===", prefix)

    # 1. Stop ILM
    try:
        es_client.ilm.stop()
        logger.info("ILM stopped")
    except Exception as exc:
        logger.warning("Failed to stop ILM: %s", exc)

    # 2. Delete data streams matching prefix
    try:
        ds_response = es_client.indices.get_data_stream(name=f"{prefix}*")
        for ds in ds_response.get("data_streams", []):
            try:
                es_client.indices.delete_data_stream(name=ds["name"])
                logger.info("Deleted data stream: %s", ds["name"])
            except Exception as exc:
                logger.warning("Failed to delete data stream '%s': %s", ds["name"], exc)
    except Exception:
        pass

    # 3. Delete snapshot repositories
    try:
        repos = es_client.snapshot.get_repository(name=f"{prefix}*")
        for repo_name in repos:
            try:
                es_client.snapshot.delete_repository(name=repo_name)
                logger.info("Deleted repo: %s", repo_name)
            except Exception as exc:
                logger.warning("Failed to delete repo '%s': %s", repo_name, exc)
    except Exception:
        pass

    # 4. Delete cloud storage buckets (force=True to empty before deleting)
    try:
        from deepfreeze_core.s3client import s3_client_factory

        s3 = s3_client_factory(storage_provider)
        buckets = s3.list_buckets(prefix=prefix)
        for bucket_name in buckets:
            try:
                s3.delete_bucket(bucket_name, force=True)
                logger.info("Deleted bucket: %s", bucket_name)
            except Exception as exc:
                logger.warning("Failed to delete bucket '%s': %s", bucket_name, exc)
    except Exception as exc:
        logger.warning("Failed to clean storage buckets: %s", exc)

    # 5. Delete ILM policies
    try:
        all_policies = es_client.ilm.get_lifecycle()
        for name in all_policies:
            if name.startswith(prefix):
                try:
                    es_client.ilm.delete_lifecycle(name=name)
                    logger.info("Deleted ILM policy: %s", name)
                except Exception as exc:
                    logger.warning("Failed to delete ILM policy '%s': %s", name, exc)
    except Exception:
        pass

    # 6. Delete index templates
    try:
        es_client.indices.delete_index_template(name=test_prefixes.index_template_name)
        logger.info("Deleted index template: %s", test_prefixes.index_template_name)
    except Exception:
        pass

    # 7. Delete status and audit indices
    for idx in [STATUS_INDEX, "deepfreeze-audit"]:
        try:
            if es_client.indices.exists(index=idx):
                es_client.indices.delete(index=idx)
                logger.info("Deleted index: %s", idx)
        except Exception as exc:
            logger.warning("Failed to delete index '%s': %s", idx, exc)

    # 8. Delete any remaining indices matching prefix
    try:
        es_client.indices.delete(index=f"{prefix}*", ignore_unavailable=True)
        logger.info("Deleted indices matching '%s*'", prefix)
    except Exception:
        pass

    # 9. Restart ILM
    try:
        es_client.ilm.start()
        logger.info("ILM restarted")
    except Exception as exc:
        logger.warning("Failed to restart ILM: %s", exc)

    # 10. Restore ILM poll interval to default (in case test didn't finish)
    try:
        es_client.cluster.put_settings(
            body={"transient": {"indices.lifecycle.poll_interval": None}}
        )
    except Exception:
        pass

    logger.info("=== Cleanup complete ===")


# ---------------------------------------------------------------------------
# Timestamp each test in terminal output
# ---------------------------------------------------------------------------

def pytest_runtest_logstart(nodeid, location):
    """Print a timestamp to the terminal when each test starts running.

    This fires *before* the test executes, so you can see which test
    is currently running and when it started — even during long waits.

    Uses os.write() to the real fd 2 (stderr) to avoid conflicts with
    Click's CliRunner which temporarily redirects sys.stderr.
    """
    import os
    from datetime import datetime
    ts = datetime.now().strftime("%H:%M:%S")
    short_name = nodeid.split("::")[-1]
    try:
        os.write(2, f"[{ts}] starting {short_name}\n".encode())
    except OSError:
        pass  # fd 2 not available (e.g., redirected to /dev/null)


# ---------------------------------------------------------------------------
# Failure diagnostics hook
# ---------------------------------------------------------------------------

@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    if report.when == "call" and report.failed:
        es = item.funcargs.get("es_client")
        prefixes = item.funcargs.get("test_prefixes")
        if es and prefixes:
            write_failure_diagnostics(
                test_name=item.nodeid,
                es_client=es,
                prefix=prefixes.repo_name_prefix,
            )
