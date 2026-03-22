"""Entry point for deepfreeze-tui."""

import argparse
import asyncio
import sys

from .app import DeepfreezeApp


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        prog="deepfreeze-tui",
        description="Terminal UI for deepfreeze",
    )
    parser.add_argument(
        "--config",
        "-c",
        help="Path to configuration file",
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

    # Run the TUI app
    app = DeepfreezeApp(config_path=args.config, refresh_interval=args.refresh)
    app.run()


if __name__ == "__main__":
    main()
