# Deepfreeze Core

Core library for Elasticsearch cloud storage archival operations.

## Overview

This package provides the shared functionality for deepfreeze operations, used by both:
- **deepfreeze-cli**: Standalone CLI tool
- **elasticsearch-curator**: Full Curator with deepfreeze support

## Supported Cloud Providers

| Provider | Storage Type | Archive Tier | Package |
|----------|--------------|--------------|---------|
| **AWS** | S3 | Glacier, Deep Archive | boto3 (included) |
| **Azure** | Blob Storage | Archive tier | azure-storage-blob (optional) |
| **GCP** | Cloud Storage | Archive class | google-cloud-storage (optional) |

## Installation

```bash
# Base installation (AWS support only)
pip install deepfreeze-core

# With Azure support
pip install deepfreeze-core[azure]

# With GCP support
pip install deepfreeze-core[gcp]

# With all providers
pip install deepfreeze-core[azure,gcp]
```

## Usage

This package is typically used as a dependency by other packages. For direct usage:

```python
from deepfreeze_core import (
    Setup, Status, Rotate, Thaw, Refreeze, Cleanup, RepairMetadata,
    s3_client_factory, create_es_client, get_storage_credentials
)

# Create ES client
client = create_es_client(
    hosts=["https://localhost:9200"],
    username="elastic",
    password="changeme"
)

# Create storage client (AWS)
s3 = s3_client_factory("aws", region="us-east-1")

# Create storage client (Azure)
s3 = s3_client_factory("azure", connection_string="...")

# Create storage client (GCP)
s3 = s3_client_factory("gcp", project="my-project")

# Or load credentials from config file
creds = get_storage_credentials("/path/to/config.yaml", "azure")
s3 = s3_client_factory("azure", **creds)

# Create and run an action
status = Status(client=client)
status.do_action()
```

## Components

### Actions
- `Setup` - Initialize deepfreeze environment
- `Status` - Display status of repositories and thaw requests
- `Rotate` - Create new repository, archive old ones
- `Thaw` - Restore data from archive storage
- `Refreeze` - Return thawed data to archive storage
- `Cleanup` - Remove expired repositories and requests
- `RepairMetadata` - Fix metadata discrepancies

### Storage Clients
- `s3_client_factory(provider, **kwargs)` - Create storage client for any provider
- `AwsS3Client` - AWS S3 implementation
- `AzureBlobClient` - Azure Blob Storage implementation
- `GcpStorageClient` - Google Cloud Storage implementation

### Utilities
- `create_es_client` - Create Elasticsearch client
- `get_storage_credentials` - Load storage credentials from config file
- `load_storage_config` - Load all storage configuration from config file
- Repository and Settings management functions

## Configuration

Storage credentials can be provided via:

1. **Constructor arguments** (highest priority)
2. **Config file** (storage section)
3. **Environment variables** (fallback)

### Config File Format

```yaml
storage:
  aws:
    region: us-east-1
    profile: my-profile  # or access_key_id + secret_access_key

  azure:
    connection_string: "DefaultEndpointsProtocol=https;..."
    # or account_name + account_key

  gcp:
    project: my-project
    credentials_file: /path/to/service-account.json
```

### Environment Variables

**AWS:** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`, `AWS_PROFILE`

**Azure:** `AZURE_STORAGE_CONNECTION_STRING` or `AZURE_STORAGE_ACCOUNT` + `AZURE_STORAGE_KEY`

**GCP:** `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`

## Development

```bash
# Install with dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Format code
black deepfreeze_core/
ruff check deepfreeze_core/
```
