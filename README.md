# Deepfreeze

Elasticsearch S3 Glacier archival and lifecycle management.

Deepfreeze enables you to archive Elasticsearch searchable snapshots to S3 Glacier storage and restore them on demand, providing significant cost savings for long-term data retention.

## Packages

This repository contains two packages:

### deepfreeze-core

Core library providing the business logic for deepfreeze operations. Used by both the standalone CLI and Elasticsearch Curator.

```bash
pip install git+https://github.com/elastic/deepfreeze.git#subdirectory=packages/deepfreeze-core
```

### es-deepfreeze

Standalone CLI tool for managing Elasticsearch S3 Glacier archives.

```bash
pip install git+https://github.com/elastic/deepfreeze.git#subdirectory=packages/es-deepfreeze
```

## Features

- **Setup**: Configure ILM policies, index templates, and S3 buckets for deepfreeze
- **Rotate**: Create new snapshot repositories on a schedule (weekly/monthly/yearly)
- **Status**: View the current state of all deepfreeze components
- **Thaw**: Restore data from Glacier for analysis
- **Refreeze**: Return thawed data to Glacier storage
- **Cleanup**: Remove expired thaw requests and associated resources
- **Repair Metadata**: Fix inconsistencies in the deepfreeze status index

## Quick Start

1. Install the CLI:
   ```bash
   pip install git+https://github.com/elastic/deepfreeze.git#subdirectory=packages/es-deepfreeze
   ```

2. Create a configuration file (`config.yml`):
   ```yaml
   elasticsearch:
     hosts:
       - https://localhost:9200
     username: elastic
     password: changeme

   deepfreeze:
     provider: aws
     bucket_name_prefix: my-deepfreeze
     repo_name_prefix: deepfreeze
     rotate_by: week
   ```

3. Initialize deepfreeze:
   ```bash
   deepfreeze setup --config config.yml
   ```

4. Check status:
   ```bash
   deepfreeze status --config config.yml
   ```

## Integration with Curator

Elasticsearch Curator can use deepfreeze-core as a dependency. See the [Curator documentation](https://github.com/wortmanb/curator) for integration details.

## Development

### Local Setup

```bash
# Clone the repository
git clone https://github.com/elastic/deepfreeze.git
cd deepfreeze

# Install both packages in development mode
pip install -e packages/deepfreeze-core[dev]
pip install -e packages/es-deepfreeze[dev]

# Run tests
pytest tests/
```

### Project Structure

```
deepfreeze/
├── packages/
│   ├── deepfreeze-core/     # Core library
│   │   └── deepfreeze_core/
│   └── es-deepfreeze/       # Standalone CLI
│       └── deepfreeze/
├── tests/
│   ├── core/                # Core library tests
│   └── cli/                 # CLI tests
└── .github/workflows/       # CI/CD
```

## License

Apache License 2.0
