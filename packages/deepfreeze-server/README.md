# deepfreeze-server

Persistent daemon for deepfreeze — REST API, background job management, SSE push events, and the React/Elastic EUI frontend.

Persistent background daemon that owns all state, scheduling, and job execution. The CLI connects to it over HTTP; the Web UI is served directly.

## Installation

```bash
pip install -e packages/deepfreeze-server
```

## Quick Start (Development)

```bash
# Terminal 1 — Server
deepfreeze-server --config ~/.deepfreeze/config.yml --reload

# Terminal 2 — Frontend dev server (hot reload)
cd packages/deepfreeze-server/frontend
npm install
npm run dev
```

Browse to `http://localhost:5173` (Vite dev server proxies API calls to the backend).

## Production Build

The frontend must be built and bundled into the package **before** `pip install`,
so the compiled assets are included in the installed package. Use `install.sh`
(recommended) which handles this automatically, or do it manually:

```bash
# 1. Build the frontend
cd packages/deepfreeze-server/frontend
npm install
npm run build      # outputs to frontend/dist/
cd ../../..

# 2. Copy built assets into the package directory
cp -r packages/deepfreeze-server/frontend/dist \
      packages/deepfreeze-server/deepfreeze_server/static

# 3. Install the server package (assets are now bundled)
pip install packages/deepfreeze-server
```

Then run the server:

```bash
deepfreeze-server --config ~/.deepfreeze/config.yml
```

Browse to `http://<host>:8000`

> **Development note:** When using `pip install -e` (editable), the server also
> auto-detects `frontend/dist/` relative to the source tree. Run `npm run dev`
> in the `frontend/` directory for hot-reload during development.

## Docker

The server can run as a container instead of a systemd service. A multi-stage
`Dockerfile` and a `docker-compose.yml` live at the **repository root**. The
image builds the frontend, bundles it into the package, and installs
`deepfreeze-core` (with the `azure` + `gcp` extras by default), `deepfreeze-cli`,
and `deepfreeze-server`. It runs as a non-root user and exposes port `8000`.

### Quick start (Compose)

```bash
# From the repo root:
cp packages/deepfreeze-cli/config.yml.example ./config.yml
$EDITOR ./config.yml            # set Elasticsearch connection, auth tokens, etc.
docker compose up -d --build
# Browse to http://localhost:8000
```

### Plain Docker

```bash
docker build -t deepfreeze-server .
docker run -d --name deepfreeze-server -p 8000:8000 \
  -v "$PWD/config.yml:/etc/deepfreeze/config.yml:ro" \
  deepfreeze-server
```

The container runs `deepfreeze-server --config /etc/deepfreeze/config.yml
--host 0.0.0.0 --port 8000`. Mount your config at that path.

### Connecting to Elasticsearch

Deepfreeze talks to an **external** Elasticsearch cluster — none is bundled.
`elasticsearch.hosts` in your config must be reachable **from inside the
container**:

- ES on the Docker host → use `https://host.docker.internal:9200` (the Compose
  file adds the `host-gateway` mapping so this works on Linux too), not
  `localhost`.
- ES elsewhere → use its real hostname/IP, or attach the container to the same
  Docker network as your ES service.

### Cloud storage credentials

For self-managed clusters using ambient credentials, supply them either by
mounting the credential files or via environment variables (see the commented
examples in `docker-compose.yml`):

> **Credential files must be mounted, and `config.yml` must reference the
> in-container path.** Any file path in `config.yml` (e.g.
> `storage.gcp.credentials_file`, TLS cert/key) is resolved *inside* the
> container. A host path that isn't mounted does not exist there, and the server
> fails at startup with `[Errno 2] No such file or directory: '<host path>'`. So:
> (1) add a volume mapping `host/path:/etc/deepfreeze/<name>:ro`, and (2) set the
> config value to the right-hand (in-container) path. Mounted files must be
> readable by uid 1000 (`chmod 644`).

| Provider | Mount | or Env |
|----------|-------|--------|
| AWS   | `-v ~/.aws:/home/deepfreeze/.aws:ro` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION` |
| GCP   | `-v ./sa.json:/home/deepfreeze/.gcp/creds.json:ro` | `GOOGLE_APPLICATION_CREDENTIALS=/home/deepfreeze/.gcp/creds.json` |
| Azure | — | `AZURE_STORAGE_CONNECTION_STRING` |

If `config.server.tls` is set, mount the cert/key into the container and point
the config at the mounted paths.

### Build options & updating

- Slim the image to one provider: `docker compose build --build-arg
  CORE_EXTRAS="[gcp]"` (or `"[azure]"`, or `""` for AWS-only).
- Update to a new version: `git pull && docker compose up -d --build` — the
  frontend and packages are rebuilt as part of the image, so no separate
  rebuild step is needed (unlike the systemd install).

## Configuration

The server reads the same `~/.deepfreeze/config.yml` used by the CLI. An optional `server` section controls server-specific settings:

```yaml
elasticsearch:
  hosts:
    - https://localhost:9200
  username: elastic
  password: changeme

# Optional — server-specific settings
server:
  host: 0.0.0.0
  port: 8000
  cors_origins:
    - "*"
  refresh_interval: 30.0   # status cache refresh in seconds
```

Environment variable overrides:

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPFREEZE_HOST` | `0.0.0.0` | Bind address |
| `DEEPFREEZE_PORT` | `8000` | Listen port |

## CLI Options

```
deepfreeze-server [OPTIONS]

  --config, -c PATH     Path to config file (default: ~/.deepfreeze/config.yml)
  --host HOST           Bind address (overrides config/env)
  --port, -p PORT       Listen port (overrides config/env)
  --reload              Enable auto-reload for development
  --cors-origin URL     Allowed CORS origin (repeatable, default: *)
```

## API Reference

### Health & Readiness

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Basic liveness check (always `{"status": "ok"}`) |
| `GET /ready` | Readiness check — ES connectivity and cache state |

### Status (cached, read-only)

| Endpoint | Description |
|----------|-------------|
| `GET /api/status` | Full system status (cluster, repos, thaw, buckets, ILM) |
| `GET /api/status?force_refresh=true` | Bypass cache, fetch fresh from ES |
| `GET /api/status/cluster` | Cluster health only |
| `GET /api/status/repositories` | All repositories |
| `GET /api/status/thaw-requests` | All thaw requests |
| `GET /api/status/buckets` | S3 buckets |
| `GET /api/status/ilm-policies` | ILM policies |
| `GET /api/history` | Recent action history from audit log |
| `GET /api/audit` | Full audit log entries (`?limit=50&action=rotate`) |
| `GET /api/thaw-requests/{id}/restore-progress` | S3 restore progress per repo |

### Actions (mutating)

All action endpoints accept a JSON body and return the action result.

| Endpoint | Body Fields |
|----------|-------------|
| `POST /api/actions/rotate` | `year`, `month`, `keep`, `dry_run` |
| `POST /api/actions/thaw` | `start_date`, `end_date`, `duration`, `tier`, `sync`, `dry_run` |
| `POST /api/actions/thaw/check` | `request_id` (optional — omit to check all) |
| `POST /api/actions/refreeze` | `request_id` (optional — omit for all), `dry_run` |
| `POST /api/actions/cleanup` | `refrozen_retention_days`, `dry_run` |
| `POST /api/actions/repair` | `dry_run` |
| `POST /api/actions/setup` | `repo_name_prefix`, `bucket_name_prefix`, `ilm_policy_name`, `index_template_name`, `dry_run` |

### Jobs

| Endpoint | Description |
|----------|-------------|
| `GET /api/jobs` | List all tracked jobs (`?status=running` to filter) |
| `GET /api/jobs/{id}` | Get a specific job with progress/result/error |
| `DELETE /api/jobs/{id}` | Cancel a running or pending job |

### Server-Sent Events (SSE)

```
GET /api/events               → all events
GET /api/events?channel=jobs  → job lifecycle events only
```

Channels: `jobs`, `status`, `thaw`, `scheduler`

Event types:
- `job.started`, `job.progress`, `job.completed`, `job.failed`, `job.cancelled`
- `status.changed`
- `thaw.completed`
- `scheduler.fired`

Example:

```
event: job.completed
data: {"job_id": "a1b2c3d4e5f6", "type": "rotate", "success": true, "summary": "Action completed successfully"}

event: status.changed
data: {"reason": "rotate_completed"}
```

## Running as a systemd Service

1. Build the frontend (see above).

2. Copy the service file and edit it:

```bash
sudo cp packages/deepfreeze-server/deepfreeze-server.service /etc/systemd/system/
sudo vi /etc/systemd/system/deepfreeze-server.service
```

Update: `User`, `Environment PATH`, `ExecStart` path, `WorkingDirectory`.

3. Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable deepfreeze-server
sudo systemctl start deepfreeze-server
```

4. Check status and logs:

```bash
sudo systemctl status deepfreeze-server
journalctl -u deepfreeze-server -f
```

## Architecture

```
deepfreeze-server/
├── deepfreeze_server/
│   ├── app.py                  # FastAPI app factory
│   ├── config.py               # YAML + env var config
│   ├── __main__.py             # uvicorn entry point
│   ├── api/                    # Transport layer (REST + SSE)
│   │   ├── status.py           # GET /api/status/*
│   │   ├── actions.py          # POST /api/actions/*
│   │   ├── jobs.py             # GET/DELETE /api/jobs/*
│   │   ├── events.py           # GET /api/events (SSE)
│   │   ├── health.py           # GET /health, /ready
│   │   ├── scheduler.py        # GET/POST/DELETE /api/scheduler/*
│   │   ├── auth.py             # Token auth middleware
│   │   └── deps.py             # Shared FastAPI dependencies
│   ├── orchestration/          # Service layer
│   │   ├── orchestrator.py     # Central coordinator
│   │   ├── status_cache.py     # Pre-cached ES status
│   │   ├── job_manager.py      # Background job tracking
│   │   ├── event_bus.py        # In-process pub/sub
│   │   └── scheduler.py       # APScheduler recurring jobs
│   └── models/                 # Pydantic models
│       ├── status.py, commands.py, jobs.py, events.py, errors.py
└── frontend/                   # React/EUI SPA
```

Key design decisions:
- **StatusCache** calls `Status._gather_status_info()` directly, bypassing the stdout/JSON capture used by the old service layer
- **EventBus** uses bounded async queues per subscriber with drop-oldest for slow consumers
- **JobManager** tracks jobs in-memory; completed jobs are recorded in the ES audit index
- All blocking ES/S3 calls run in thread pool executors to avoid blocking the event loop

## Capabilities

- `/health` and `/ready` endpoints for operational monitoring
- `/api/jobs` for tracking background job state
- `/api/events` SSE endpoint for push updates
- `/api/scheduler/jobs` for managing recurring scheduled jobs
- Token-based auth with roles (admin/operator/viewer) — opt-in
- TLS support via config
- Background status cache refresh (no more per-request ES queries)
- Automatic cache invalidation after mutating actions

## Web UI Pages

| Page | Description |
|------|-------------|
| Overview | Cluster health, repo/thaw/bucket/ILM counts — click any card for details |
| Repositories | Sortable, searchable repo table with flyout detail view |
| Thaw Requests | Thaw request table with status, date range, repo list |
| Actions | Run Thaw, Cleanup, Refreeze, Fix/Repair, Rotate with dry-run option |
| Activity | Audit log from Elasticsearch with full detail flyouts |
