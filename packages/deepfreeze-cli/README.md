# Deepfreeze

Standalone Elasticsearch cloud storage archival and lifecycle management tool.

## Overview

Deepfreeze provides cost-effective cloud storage archival and lifecycle management for Elasticsearch snapshot repositories without requiring full Curator installation. It is a lightweight, focused tool for managing long-term data retention in cloud archive storage.

## Supported Cloud Providers

| Provider | Storage Type | Archive Tier |
|----------|--------------|--------------|
| **AWS** | S3 | Glacier, Glacier Deep Archive |
| **Azure** | Blob Storage | Archive tier |
| **GCP** | Cloud Storage | Archive storage class |

## Features

- Cloud archive storage for Elasticsearch snapshot repositories
- Repository rotation with configurable retention
- Thaw frozen repositories for data retrieval
- Automatic refreeze after data access
- ILM policy integration
- Dry-run mode for all operations
- Machine-readable (porcelain) output

## Installation

### From PyPI (when published)

```bash
pip install deepfreeze-cli
```

### From Source

```bash
# Clone the repository
git clone https://github.com/wortmanb/curator.git
cd curator/deepfreeze

# Install in development mode
pip install -e .

# Or install with development dependencies
pip install -e ".[dev]"
```

### Verify Installation

```bash
# Check that deepfreeze is installed
deepfreeze --version

# Show help
deepfreeze --help
```

## Requirements

- Python 3.8 or higher
- Elasticsearch 8.x cluster
- Cloud provider credentials (one of):
  - **AWS**: AWS credentials via environment, config file, or IAM role
  - **Azure**: Connection string or account name + key
  - **GCP**: Application Default Credentials or service account JSON
- Required Python packages (installed automatically):
  - elasticsearch8
  - boto3 (for AWS)
  - click
  - rich
  - voluptuous
  - pyyaml
- Optional packages for additional providers:
  - azure-storage-blob (for Azure): `pip install deepfreeze-cli[azure]`
  - google-cloud-storage (for GCP): `pip install deepfreeze-cli[gcp]`

## Configuration

### Default Configuration File

Deepfreeze looks for a configuration file at:

```
~/.deepfreeze/config.yml
```

If this file exists, it will be used automatically. You can override it with the `--config` flag.

### Quick Start

```bash
# Create config directory
mkdir -p ~/.deepfreeze

# Copy example config
cp config.yml.example ~/.deepfreeze/config.yml

# Edit with your settings
vim ~/.deepfreeze/config.yml
```

### Configuration Format

Create a YAML configuration file to specify Elasticsearch connection and storage provider settings:

```yaml
elasticsearch:
  hosts:
    - https://localhost:9200
  username: elastic
  password: changeme
  # Optional SSL settings
  ca_certs: /path/to/ca.crt
  # Or use API key authentication
  # api_key: your-api-key
  # Or use Elastic Cloud
  # cloud_id: deployment:base64string

# Storage provider credentials (optional - can also use environment variables)
storage:
  # AWS S3 configuration
  aws:
    region: us-east-1
    # profile: my-profile  # Use named profile from ~/.aws/credentials
    # Or explicit credentials:
    # access_key_id: AKIA...
    # secret_access_key: ...

  # Azure Blob Storage configuration
  azure:
    connection_string: "DefaultEndpointsProtocol=https;AccountName=...;AccountKey=..."
    # Or use account name + key:
    # account_name: mystorageaccount
    # account_key: ...

  # Google Cloud Storage configuration
  gcp:
    project: my-gcp-project
    credentials_file: /path/to/service-account.json
    location: US

logging:
  loglevel: INFO
  # logfile: /var/log/deepfreeze.log
```

### Environment Variables

Configuration can also be provided via environment variables:

**Elasticsearch:**
- `DEEPFREEZE_ES_HOSTS` - Elasticsearch hosts (comma-separated)
- `DEEPFREEZE_ES_USERNAME` - Elasticsearch username
- `DEEPFREEZE_ES_PASSWORD` - Elasticsearch password
- `DEEPFREEZE_ES_API_KEY` - Elasticsearch API key
- `DEEPFREEZE_ES_CLOUD_ID` - Elastic Cloud ID

**AWS S3:**
- `AWS_ACCESS_KEY_ID` - AWS access key
- `AWS_SECRET_ACCESS_KEY` - AWS secret key
- `AWS_DEFAULT_REGION` - AWS region
- `AWS_PROFILE` - AWS profile name

**Azure Blob Storage:**
- `AZURE_STORAGE_CONNECTION_STRING` - Full connection string
- `AZURE_STORAGE_ACCOUNT` - Storage account name (with AZURE_STORAGE_KEY)
- `AZURE_STORAGE_KEY` - Storage account key

**Google Cloud Storage:**
- `GOOGLE_APPLICATION_CREDENTIALS` - Path to service account JSON
- `GOOGLE_CLOUD_PROJECT` - GCP project ID
- `GOOGLE_CLOUD_LOCATION` - Default bucket location

Environment variables are used as fallback when config file credentials are not provided.

## Usage

### Initial Setup

Set up deepfreeze with ILM policy and index template configuration:

```bash
# AWS (default)
deepfreeze --config config.yaml setup \
  --ilm_policy_name my-ilm-policy \
  --index_template_name my-template \
  --bucket_name_prefix my-deepfreeze \
  --repo_name_prefix my-deepfreeze

# Azure
deepfreeze --config config.yaml setup \
  --provider azure \
  --ilm_policy_name my-ilm-policy \
  --bucket_name_prefix my-deepfreeze \
  --repo_name_prefix my-deepfreeze

# GCP
deepfreeze --config config.yaml setup \
  --provider gcp \
  --ilm_policy_name my-ilm-policy \
  --bucket_name_prefix my-deepfreeze \
  --repo_name_prefix my-deepfreeze
```

### Check Status

View the current state of repositories and thaw requests:

```bash
# Human-readable output
deepfreeze --config config.yaml status

# Machine-readable JSON output
deepfreeze --config config.yaml status --porcelain
```

### Rotate Repositories

Create a new repository and archive old ones to Glacier:

```bash
# Rotate with default settings (keep 6 most recent)
deepfreeze --config config.yaml rotate

# Keep only 3 most recent repositories
deepfreeze --config config.yaml rotate --keep 3

# Dry run to see what would happen
deepfreeze --config config.yaml --dry-run rotate
```

### Thaw Frozen Repositories

Retrieve data from Glacier storage:

```bash
# Thaw repositories for a date range (dates in ISO 8601 date-time, e.g. YYYY-MM-DDTHH:MM:SSZ)
deepfreeze --config config.yaml thaw \
  --start-date 2024-01-01T00:00:00Z \
  --end-date 2024-06-30T23:59:59Z

# Check thaw request status
deepfreeze --config config.yaml thaw --check-status <request-id>

# List all thaw requests
deepfreeze --config config.yaml thaw --list
```

### Refreeze Repositories

Return thawed repositories to Glacier:

```bash
# Refreeze a specific request
deepfreeze --config config.yaml refreeze --thaw-request-id <request-id>

# Refreeze all completed thaw requests
deepfreeze --config config.yaml refreeze --all
```

### Cleanup

Remove expired repositories and old thaw requests:

```bash
deepfreeze --config config.yaml cleanup

# Custom retention period for refrozen requests
deepfreeze --config config.yaml cleanup --refrozen-retention-days 60
```

### Repair Metadata

Scan and repair repository metadata discrepancies:

```bash
deepfreeze --config config.yaml repair-metadata

# Dry run
deepfreeze --config config.yaml --dry-run repair-metadata
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `setup` | Initialize deepfreeze environment (supports `--provider` option) |
| `status` | Show current status of repositories and requests |
| `rotate` | Create new repository and archive old ones |
| `thaw` | Initiate or check archive restore operations |
| `refreeze` | Return thawed repositories to archive storage |
| `cleanup` | Remove expired repositories and old requests |
| `repair-metadata` | Scan and repair metadata discrepancies |

## Global Options

| Option | Description |
|--------|-------------|
| `--config`, `-c` | Path to YAML configuration file |
| `--dry-run` | Show what would be done without making changes |
| `--version` | Show version and exit |
| `--help` | Show help message |

## Testing

Run the test suite:

```bash
# Install development dependencies
pip install -e ".[dev]"

# Run all tests
pytest

# Run with coverage
pytest --cov=deepfreeze --cov-report=term-missing

# Run specific test file
pytest tests/test_actions.py
```

### Test Environment Requirements

- Tests use mocked Elasticsearch and S3 clients
- No live Elasticsearch or AWS connection required
- All tests run in isolation

## Independence from Curator

Deepfreeze is a standalone package that operates independently of Elasticsearch Curator. It:

- Has no imports from the curator package
- Uses its own Elasticsearch client wrapper (not es_client.builder)
- Maintains its own exception classes
- Can be installed and run without curator

## License

Apache-2.0
