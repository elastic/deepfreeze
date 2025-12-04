# Deepfreeze Core

Core library for Elasticsearch S3 Glacier archival operations.

## Overview

This package provides the shared functionality for deepfreeze operations, used by both:
- **deepfreeze-cli**: Standalone CLI tool
- **elasticsearch-curator**: Full Curator with deepfreeze support

## Installation

```bash
pip install deepfreeze-core
```

## Usage

This package is typically used as a dependency by other packages. For direct usage:

```python
from deepfreeze_core import (
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
black deepfreeze_core/
ruff check deepfreeze_core/
```
