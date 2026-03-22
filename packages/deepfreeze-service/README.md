# deepfreeze-service

Async service layer for deepfreeze - wraps the core CLI functionality with structured APIs for UI consumption.

## Features

- **Async API**: Non-blocking wrappers for all deepfreeze actions
- **Structured Models**: Pydantic models for type-safe responses
- **Error Handling**: Maps exceptions to structured ServiceError objects
- **Action History**: In-memory tracking of recent operations
- **Status Polling**: Configurable auto-refresh for dashboard UIs

## Installation

```bash
pip install -e packages/deepfreeze-service
```

## Usage

```python
from deepfreeze_service import DeepfreezeService

# Initialize service
service = DeepfreezeService(config_path="/etc/deepfreeze/config.yml")

# Get system status
status = await service.get_status()

# Execute commands
result = await service.rotate(keep=6, dry_run=True)
result = await service.thaw_create(
    start_date=datetime(2024, 1, 1),
    end_date=datetime(2024, 1, 31),
    sync=False
)
result = await service.refreeze(request_id="thaw-001")
result = await service.cleanup(refrozen_retention_days=30)
result = await service.repair_metadata(dry_run=True)
```

## Architecture

- **DeepfreezeService**: Main class exposing all operations
- **Models**: Pydantic models for SystemStatus, CommandResult, etc.
- **Error Mapping**: Converts exceptions to structured ServiceError objects
- **Polling**: Built-in support for status auto-refresh

## Dependencies

- deepfreeze-core
- elasticsearch8
- pydantic>=2.0
