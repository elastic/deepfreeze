# Elastic Deepfreeze Core

Core library for Elasticsearch S3 Glacier archival operations.

## Overview

This package provides the shared functionality for deepfreeze operations, used by both:
- **elastic-deepfreeze-cli**: Standalone CLI tool
- **elasticsearch-curator**: Full Curator with deepfreeze support

## Installation

```bash
pip install elastic-deepfreeze-core
```

Or from source:
```bash
pip install git+https://github.com/elastic/deepfreeze.git#subdirectory=packages/elastic-deepfreeze-core
```

## Usage

This package is typically used as a dependency by other packages. For direct usage:

```python
from elastic_deepfreeze_core import (
    Setup, Status, Rotate, Thaw, Refreeze, Cleanup, RepairMetadata,
    s3_client_factory, create_es_client
)

# Create ES client
client = create_es_client(hosts=["https://localhost:9200"], username="elastic", password="changeme")

# Create and run an action
status = Status(client=client)
status.do_action()
```

## Components

### Actions
- `Setup` - Initialize deepfreeze environment
- `Status` - Display status of repositories and thaw requests
- `Rotate` - Create new repository, archive old ones to Glacier
- `Thaw` - Restore data from Glacier storage
- `Refreeze` - Return thawed data to Glacier
- `Cleanup` - Remove expired repositories and requests
- `RepairMetadata` - Fix metadata discrepancies

### Utilities
- `s3_client_factory` - Create S3 client for AWS
- `create_es_client` - Create Elasticsearch client
- Repository and Settings management functions

## Development

```bash
# Install with dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Format code
black elastic_deepfreeze_core/
ruff check elastic_deepfreeze_core/
```

## Why "elastic-deepfreeze-core"?

The package name includes the `elastic-` prefix to prevent dependency confusion attacks. See the [main README](../../README.md) for details.
