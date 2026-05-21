# Deepfreeze

[![Tests](https://github.com/wortmanb/deepfreeze/actions/workflows/test.yml/badge.svg)](https://github.com/wortmanb/deepfreeze/actions/workflows/test.yml)

Elasticsearch cloud storage archival and lifecycle management.

Deepfreeze enables you to archive Elasticsearch searchable snapshots to cloud archive storage (AWS Glacier, Azure Archive, GCP Archive) and restore them on demand, providing significant cost savings for long-term data retention.

See Elastic Search Labs blog post at https://www.elastic.co/search-labs/blog/s3-glacier-archiving-elasticsearch-deepfreeze

## Packages

| Package | Description |
|---------|-------------|
| [deepfreeze-core](packages/deepfreeze-core/README.md) | Core domain logic library — actions, ES/storage clients, audit |
| [deepfreeze-cli](packages/deepfreeze-cli/README.md) | Standalone CLI tool (local or remote via server) |
| [deepfreeze-server](packages/deepfreeze-server/README.md) | Persistent daemon — REST API, job management, SSE events, Web UI |

## Documentation

| Topic | Document |
|-------|----------|
| AWS credentials for the Kibana plugin (keystore, env vars, SSO, EC2/ECS/EKS roles) | [AWS_CREDENTIALS.md](AWS_CREDENTIALS.md) |
| Contributing to deepfreeze | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Code of conduct | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |

## Supported Cloud Providers

| Provider | Storage Type | Archive Tier |
|----------|--------------|--------------|
| **AWS** | S3 | Glacier, Glacier Deep Archive |
| **Azure** | Blob Storage | Archive tier |
| **GCP** | Cloud Storage | Archive storage class |

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
- A running Elasticsearch 8.x or 9.x cluster
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
├── install.sh                 # Interactive installer
├── tests/
└── .github/workflows/
```

## License

Apache License 2.0
