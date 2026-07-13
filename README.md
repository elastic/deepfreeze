# Deepfreeze

[![Tests](https://github.com/wortmanb/deepfreeze/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/wortmanb/deepfreeze/actions/workflows/test.yml)

Elasticsearch cloud storage archival and lifecycle management.

Deepfreeze enables you to archive Elasticsearch searchable snapshots to cloud archive storage (AWS Glacier, Azure Archive, GCP Archive) and restore them on demand, providing significant cost savings for long-term data retention.

See Elastic Search Labs blog post at https://www.elastic.co/search-labs/blog/s3-glacier-archiving-elasticsearch-deepfreeze

> **Supported clusters:** deepfreeze works with **self-managed (on-prem)** and
> **Elastic Cloud Hosted (ECH)** Elasticsearch clusters. It is **not supported on
> Elasticsearch Serverless**, which does not expose the snapshot, repository, and
> ILM APIs deepfreeze depends on.

## Packages

| Package | Description |
|---------|-------------|
| [deepfreeze-core](packages/deepfreeze-core/README.md) | Core domain logic library — actions, ES/storage clients, audit |
| [deepfreeze-cli](packages/deepfreeze-cli/README.md) | Standalone CLI tool (local or remote via server) |
| [deepfreeze-server](packages/deepfreeze-server/README.md) | Persistent daemon — REST API, job management, SSE events, Web UI |

## Supported Cloud Providers

| Provider | Storage Type | Archive Tier |
|----------|--------------|--------------|
| **AWS** | S3 | Glacier, Glacier Deep Archive |
| **Azure** | Blob Storage | Archive tier |
| **GCP** | Cloud Storage | Archive storage class |

## Storage prerequisites

`deepfreeze setup` **creates the storage bucket/container for you** — it does not
adopt an existing one. If the target bucket/container already exists, setup
**fails** and asks you to pick a new name or remove it (so it never overwrites
data). What must already exist *before* you run setup differs by provider:

| Provider | `setup` creates | Must already exist | Credentials need |
|----------|-----------------|--------------------|------------------|
| **AWS S3** | the bucket | nothing beyond valid credentials | `s3:CreateBucket` (+ a region) |
| **GCP GCS** | the bucket | the **project** | `storage.buckets.create`; project id set via `storage.gcp.project` or `GOOGLE_CLOUD_PROJECT` |
| **Azure Blob** | the **container** | the **storage account** | connection string / account key for that existing account |

Notes:

- **Azure is the one to watch.** deepfreeze creates only the *container*; it
  **cannot create the storage account** (that's an Azure control-plane/ARM
  operation), so the account must exist first. Point deepfreeze at it via
  `storage.azure.connection_string` (or `account_name` + `account_key`).
- **AWS and GCP bucket names are globally unique** — choose a name nobody else
  has taken.
- No provider lets you **reuse a pre-existing bucket/container** through setup; a
  name already in use is treated as an error.

> **CLI note:** when running `deepfreeze setup` directly (not via the server),
> the CLI reads storage credentials from the **environment**, not from
> `config.yml`'s `storage` block. For GCP set `GOOGLE_APPLICATION_CREDENTIALS`
> (and `GOOGLE_CLOUD_PROJECT`); for AWS use the standard `AWS_*` vars or a
> mounted profile; for Azure set `AZURE_STORAGE_CONNECTION_STRING`. The server
> bridges these from `config.yml` automatically; the CLI does not.

## Features

- **Setup**: Configure ILM policies, index templates, and storage buckets for deepfreeze
- **Rotate**: Create new snapshot repositories on a schedule (weekly/monthly/yearly)
- **Status**: View the current state of all deepfreeze components
- **Thaw**: Restore data from archive storage for analysis
- **Refreeze**: Return thawed data to archive storage
- **Cleanup**: Remove expired thaw requests and associated resources
- **Repair Metadata**: Fix inconsistencies in the deepfreeze status index
- **Audit Logging**: All mutating actions recorded to Elasticsearch
- **Web UI**: React/Elastic EUI dashboard with scheduler management
- **Remote Mode**: CLI can operate against a running deepfreeze-server

## Installation

### Prerequisites

- Python 3.10+ (Python 3.8+ for `--cli-only` installs)
- Node.js 18+ and npm (not required for `--cli-only`)
- A running Elasticsearch 8.x or 9.x cluster — **self-managed (on-prem)** or
  **Elastic Cloud Hosted (ECH)**. Elasticsearch Serverless is **not supported**.
- Cloud provider credentials (AWS, Azure, or GCP)

> **Recommended:** Install into a Python virtual environment to avoid conflicts
> with system packages.

### Quick Install

The interactive installer handles packages, frontend build, config scaffolding, and optional systemd setup:

```bash
git clone https://github.com/elastic/deepfreeze.git
cd deepfreeze
./install.sh
```

Installer options:

| Flag | Description |
|------|-------------|
| `--cli-only` | Install CLI + core only (no server or Web UI) |
| `--provider NAME` | Storage provider: `aws` (default), `azure`, `gcp` |
| `--dev` | Development mode (editable pip installs) |
| `--uninstall` | Remove deepfreeze packages |
| `-y` | Non-interactive mode (accept all defaults) |

### Manual Install

Run all commands from the repository root.

```bash
# Core + CLI only (AWS — boto3 included by default)
pip install packages/deepfreeze-core
pip install packages/deepfreeze-cli

# Full stack (build frontend first — see packages/deepfreeze-server/README.md)
pip install packages/deepfreeze-core
pip install packages/deepfreeze-cli
pip install packages/deepfreeze-server
```

### Provider extras

Azure and GCP support is optional. Install the extras on `deepfreeze-core`:

```bash
# Azure support
pip install packages/deepfreeze-core[azure]

# GCP support
pip install packages/deepfreeze-core[gcp]

# All providers
pip install packages/deepfreeze-core[azure,gcp]
```

### Common setup issues

- **`deepfreeze: command not found`** — The Python scripts directory may not be in your `PATH`.
  Find it with:
  ```bash
  python3 -c 'import sysconfig; print(sysconfig.get_path("scripts"))'
  ```
  Add it to your shell profile and open a new terminal.

- **Azure or GCP import errors** — Install provider extras on `deepfreeze-core`, not `deepfreeze-cli`.
  See [Provider extras](#provider-extras) above.

- **`deepfreeze status` fails immediately after install** — Run `deepfreeze setup` first to
  create the required Elasticsearch resources (ILM policies, index templates). See step 3 below.

- **Server starts but Web UI is blank** — The frontend was not built before `pip install`.
  Follow the production build steps in [packages/deepfreeze-server/README.md](packages/deepfreeze-server/README.md).

## Quick Start

1. **Install** (see above) or run `./install.sh` which scaffolds config interactively.

2. **Create or update a configuration file** (`~/.deepfreeze/config.yml`):
   ```yaml
   elasticsearch:
     hosts:
       - https://localhost:9200
     username: elastic
     password: changeme

   # Storage provider credentials (optional - can also use environment variables)
   storage:
     # AWS S3
     aws:
       region: us-east-1
       # profile: my-profile  # Or use access_key_id + secret_access_key

     # Azure Blob Storage
     azure:
       connection_string: "DefaultEndpointsProtocol=https;AccountName=...;AccountKey=..."
       # Or use account_name + account_key

     # Google Cloud Storage
     gcp:
       project: my-gcp-project
       credentials_file: /path/to/service-account.json
   ```

3. **Initialize deepfreeze** (required — creates ILM policies, index templates, and snapshot repos):
   ```bash
   deepfreeze setup --config ~/.deepfreeze/config.yml \
     --provider aws \
     --bucket_name_prefix my-deepfreeze \
     --repo_name_prefix my-deepfreeze
   ```

4. **Check status** (only works after `setup` has been run):
   ```bash
   deepfreeze status --config ~/.deepfreeze/config.yml
   ```

5. **Start the server** (optional):
   ```bash
   deepfreeze-server --config ~/.deepfreeze/config.yml
   ```
   This runs it in the foreground. For a persistent deployment, see
   [Deploying the Server](#deploying-the-server) below.

## Deploying the Server

The `deepfreeze-server` daemon (REST API + Web UI + scheduler) can be deployed
two ways. Both serve the API, the bundled React UI, and the in-process job
scheduler from a single process on port `8000` — pick whichever fits your
environment. Full details are in
[packages/deepfreeze-server/README.md](packages/deepfreeze-server/README.md).

> **Single process by design.** The scheduler runs inside the web process, so
> run exactly **one** server instance (one uvicorn worker). Running multiple
> replicas/workers without external coordination would fire scheduled jobs more
> than once.

### Option A — systemd service

Best when running directly on a host (the package is already pip-installed).

```bash
# The interactive installer offers to install and start the unit for you:
./install.sh
```

To set it up manually, install the packages (see [Installation](#installation),
which builds and bundles the Web UI), then install the provided unit file
[packages/deepfreeze-server/deepfreeze-server.service](packages/deepfreeze-server/deepfreeze-server.service)
(edit the `User`, paths, and `--config` to match your host):

```bash
sudo cp packages/deepfreeze-server/deepfreeze-server.service \
        /etc/systemd/system/deepfreeze-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now deepfreeze-server

# Manage it:
systemctl status deepfreeze-server
journalctl -u deepfreeze-server -f        # follow logs
sudo systemctl restart deepfreeze-server  # e.g. after an update
```

Because the Web UI is bundled into the package at install time, updating a
systemd deployment means rebuilding the frontend and reinstalling. The
[`update-testbox.sh`](update-testbox.sh) helper automates pull → rebuild →
redeploy → restart.

### Option B — Docker container

Best for a self-contained, reproducible deployment. A multi-stage `Dockerfile`
and `docker-compose.yml` live at the repository root; the image builds the
frontend, bundles it, and installs all three packages (with the `azure` + `gcp`
extras by default).

```bash
# From the repo root:
cp packages/deepfreeze-cli/config.yml.example ./config.yml
$EDITOR ./config.yml          # set Elasticsearch connection, auth tokens, etc.
docker compose up -d --build
# Browse to http://localhost:8000
```

Or with plain Docker:

```bash
docker build -t deepfreeze-server .
docker run -d --name deepfreeze-server -p 8000:8000 \
  -v "$PWD/config.yml:/etc/deepfreeze/config.yml:ro" \
  deepfreeze-server
```

Key points (see the server README's **Docker** section for the rest):

- **Elasticsearch is external** — none is bundled. `elasticsearch.hosts` must be
  reachable *from inside the container*; for ES on the Docker host use
  `https://host.docker.internal:9200`, not `localhost`.
- **Cloud credentials** are supplied via mounted files or environment variables
  (see the commented examples in `docker-compose.yml`).
- **Updating** is just `git pull && docker compose up -d --build` — the frontend
  and packages are rebuilt as part of the image, so there is no separate rebuild
  step.

## Development

### Local Setup

```bash
# Clone the repository
git clone https://github.com/elastic/deepfreeze.git
cd deepfreeze

# Install all packages in development mode
./install.sh --dev

# Or manually
pip install -e packages/deepfreeze-core[dev]
pip install -e packages/deepfreeze-cli[dev]
pip install -e packages/deepfreeze-server[dev]

# Run tests
pytest tests/
```

### Project Structure

```
deepfreeze/
├── packages/
│   ├── deepfreeze-core/       # Core domain logic library
│   ├── deepfreeze-cli/        # Standalone CLI (local + remote)
│   └── deepfreeze-server/     # Persistent daemon (REST + SSE + Web UI)
│       └── deepfreeze-server.service   # systemd unit
├── install.sh                 # Interactive installer (packages + systemd)
├── update-testbox.sh          # Pull, rebuild frontend, redeploy, restart
├── Dockerfile                 # Multi-stage server image (frontend + packages)
├── docker-compose.yml         # Container deployment
├── tests/
└── .github/workflows/
```

## License

[Elastic License 2.0](LICENSE). See the `LICENSE` file for terms.
