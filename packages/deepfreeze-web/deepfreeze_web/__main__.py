"""Entry point for deepfreeze-web."""

import argparse
import sys
from pathlib import Path

DEFAULT_CONFIG_PATH = Path.home() / ".deepfreeze" / "config.yml"


def get_default_config():
    if DEFAULT_CONFIG_PATH.is_file():
        return str(DEFAULT_CONFIG_PATH)
    return None


def main():
    parser = argparse.ArgumentParser(
        prog="deepfreeze-web",
        description="Web UI for deepfreeze",
    )
    parser.add_argument(
        "--config",
        "-c",
        help="Path to configuration file (default: ~/.deepfreeze/config.yml)",
        default=None,
    )
    parser.add_argument(
        "--host",
        help="Host to bind to (default: 0.0.0.0)",
        default="0.0.0.0",
    )
    parser.add_argument(
        "--port",
        "-p",
        type=int,
        help="Port to listen on (default: 8000)",
        default=8000,
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload for development",
        default=False,
    )

    args = parser.parse_args()

    config_path = args.config or get_default_config()
    if not config_path:
        print(
            "ERROR: No config file found. Provide --config or create ~/.deepfreeze/config.yml"
        )
        sys.exit(1)

    import uvicorn
    from .app import create_app

    app = create_app(config_path=config_path)
    uvicorn.run(app, host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
