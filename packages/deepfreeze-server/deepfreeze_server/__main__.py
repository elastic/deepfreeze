"""Entry point for deepfreeze-server daemon."""

import argparse
import sys

from .config import DEFAULT_CONFIG_PATH


def get_default_config():
    if DEFAULT_CONFIG_PATH.is_file():
        return str(DEFAULT_CONFIG_PATH)
    return None


def main():
    parser = argparse.ArgumentParser(
        prog="deepfreeze-server",
        description="Deepfreeze persistent daemon — REST API, job management, and SSE events",
    )
    parser.add_argument(
        "--config", "-c",
        help="Path to configuration file (default: ~/.deepfreeze/config.yml)",
        default=None,
    )
    parser.add_argument(
        "--host",
        help="Host to bind to (default: 0.0.0.0)",
        default=None,
    )
    parser.add_argument(
        "--port", "-p",
        type=int,
        help="Port to listen on (default: 8000)",
        default=None,
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload for development",
        default=False,
    )
    parser.add_argument(
        "--cors-origin",
        action="append",
        dest="cors_origins",
        help="Allowed CORS origin (repeatable)",
        default=None,
    )
    parser.add_argument(
        "--no-tls",
        action="store_true",
        help="Disable TLS even if configured (for development)",
        default=False,
    )

    args = parser.parse_args()

    config_path = args.config or get_default_config()
    if not config_path:
        print(
            "ERROR: No config file found. Provide --config or create ~/.deepfreeze/config.yml"
        )
        sys.exit(1)

    # Load config for host/port defaults, allow CLI overrides
    from .config import load_server_config
    server_config, _ = load_server_config(config_path)
    host = args.host or server_config.host
    port = args.port or server_config.port

    import uvicorn
    from .app import create_app

    app = create_app(config_path=config_path, cors_origins=args.cors_origins)

    # TLS support
    ssl_kwargs = {}
    if server_config.tls and not args.no_tls:
        ssl_kwargs["ssl_certfile"] = server_config.tls.cert
        ssl_kwargs["ssl_keyfile"] = server_config.tls.key
        print(f"TLS enabled: cert={server_config.tls.cert}")

    uvicorn.run(app, host=host, port=port, reload=args.reload, **ssl_kwargs)


if __name__ == "__main__":
    main()
