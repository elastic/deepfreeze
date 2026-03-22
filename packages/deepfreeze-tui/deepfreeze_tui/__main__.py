"""Entry point for deepfreeze-tui."""

import argparse
import asyncio
import sys
from pathlib import Path

from .app import DeepfreezeApp


# Default config file location (same as CLI)
DEFAULT_CONFIG_PATH = Path.home() / ".deepfreeze" / "config.yml"


def get_default_config():
    """Get the default configuration file path if it exists."""
    if DEFAULT_CONFIG_PATH.is_file():
        return str(DEFAULT_CONFIG_PATH)
    return None


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        prog="deepfreeze-tui",
        description="Terminal UI for deepfreeze",
    )
    parser.add_argument(
        "--config",
        "-c",
        help="Path to configuration file (default: ~/.deepfreeze/config.yml)",
        default=None,
    )
    parser.add_argument(
        "--refresh",
        "-r",
        type=int,
        help="Status refresh interval in seconds (default: 30)",
        default=30,
    )

    args = parser.parse_args()

    # Use provided config or try default
    config_path = args.config or get_default_config()

    if not config_path:
        print(
            "ERROR: No config file found. Please provide --config or create ~/.deepfreeze/config.yml"
        )
        sys.exit(1)

    # Run the TUI app
    app = DeepfreezeApp(config_path=config_path, refresh_interval=args.refresh)
    app.run()


if __name__ == "__main__":
    main()
