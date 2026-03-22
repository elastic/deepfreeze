# deepfreeze-tui

Terminal User Interface for deepfreeze - an operator-focused dashboard for managing Elasticsearch S3 Glacier archival.

## Features

- **Overview Dashboard**: System health, repository counts, recent activity
- **Repository Browser**: Filterable table with state badges, search, detail panel
- **Thaw Management**: Create and monitor thaw requests
- **Operations Panel**: Execute rotate, cleanup, repair-metadata, setup with dry-run support
- **Configuration View**: Read-only display of settings, ILM policies, buckets
- **Activity Logs**: Action history with filtering

## Installation

```bash
pip install -e packages/deepfreeze-tui
```

## Usage

```bash
# Launch the TUI
deepfreeze-tui

# With custom config
deepfreeze-tui --config /path/to/config.yml

# With custom refresh interval (seconds)
deepfreeze-tui --refresh 60
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1` | Overview (health dashboard) |
| `2` | Repositories |
| `3` | Thaw Requests |
| `4` | Operations |
| `5` | Configuration |
| `6` | Logs |
| `r` | Refresh status |
| `q` | Quit |
| `?` | Show help |

## Architecture

Built with [Textual](https://textual.textualize.io/) framework. Uses the `deepfreeze-service` package for backend operations.

## Design

- Dark theme matching Elastic EUI design tokens
- High signal-to-noise ratio for operators
- Keyboard-first navigation
- Works over SSH
