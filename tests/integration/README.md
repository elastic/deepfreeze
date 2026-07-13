# Deepfreeze Integration Tests

End-to-end tests that run against a real Elasticsearch cluster with real cloud storage.

## Prerequisites

- Python 3.10+
- A running Elasticsearch 8.x+ cluster
- Cloud storage credentials (AWS/Azure/GCP) configured
- `~/.deepfreeze/config.yml` with valid ES and storage credentials
- Deepfreeze packages installed: `pip install -e packages/deepfreeze-core -e packages/deepfreeze-cli -e packages/deepfreeze-server`
- Test dependencies: `pip install httpx pytest-timeout`
- For WebUI tests: `pip install playwright pytest-playwright && playwright install chromium`
- For WebUI tests: frontend must be built (`cd packages/deepfreeze-server/frontend && npm run build`)

## Configuration

Tests load config from (in priority order):
1. `DEEPFREEZE_TEST_CONFIG` env var pointing to a YAML file
2. `~/.deepfreeze/config.yml`

The config must contain a valid `elasticsearch` section and `storage` credentials for your provider.

## Clean Cluster Requirement

Tests require a **clean Elasticsearch cluster** — one where deepfreeze has NOT been initialized (no `deepfreeze-status` index). If the index exists, the test session fails immediately with instructions.

To clean up a cluster for testing:
```bash
curl -X DELETE '<host>:9200/deepfreeze-status'
curl -X DELETE '<host>:9200/deepfreeze-audit'
```

## Test Isolation

Every test run generates a unique prefix (e.g., `dftest-a3b7c2`). All artifacts — repos, buckets, ILM policies — use this prefix. Setup runs with test prefixes. Cleanup removes everything (including the status/audit indices) at session end.

## Running Tests

```bash
# Smoke tests only (verify connectivity)
pytest tests/integration/test_00_smoke.py -v

# All CLI tests (skip slow thaw tests)
pytest tests/integration/ -m "cli and not slow" -v

# API tests (requires server — started automatically)
pytest tests/integration/ -m api -v

# Full lifecycle (slow — includes thaw/restore)
pytest tests/integration/test_20_workflow_full.py -v

# WebUI browser tests
pytest tests/integration/ -m webui -v

# Everything
pytest tests/integration/ -v

# Skip webui and slow tests (fast feedback)
pytest tests/integration/ -m "integration and not slow and not webui" -v
```

## Markers

| Marker | Description |
|--------|-------------|
| `integration` | All integration tests (requires real ES) |
| `slow` | May take minutes (thaw/restore) |
| `cli` | CLI invocation tests |
| `api` | Server API tests |
| `webui` | Playwright browser tests |

## Known Limitations

- **Thaw tests** depend on cloud provider restore speed (minutes to hours for Glacier)
- **WebUI tests** require playwright and a built frontend
- **Shared clusters**: Tests are isolated by prefix but do create a `deepfreeze-status` index and `deepfreeze-audit` index that are shared across all deepfreeze installations on the same cluster
- **Cleanup**: If the test process is killed (SIGKILL), orphaned `dftest-*` artifacts may remain. Clean them manually or re-run tests (cleanup runs at session start too)

## Failure Diagnostics

When a test fails, an ES state snapshot is written to `tests/integration/.diagnostics/`. These JSON files contain all indices, repos, ILM policies, and status docs matching the test prefix — useful for post-mortem analysis.

## Expected Runtime

| Suite | Approximate Time |
|-------|-----------------|
| Smoke (`test_00`) | ~5 seconds |
| CLI fast (`cli and not slow`) | ~2 minutes |
| API (`api`) | ~1 minute |
| Full lifecycle (`test_20`) | 5-30 minutes (depends on provider) |
| WebUI (`webui`) | ~30 seconds |
| Everything | 10-35 minutes |
