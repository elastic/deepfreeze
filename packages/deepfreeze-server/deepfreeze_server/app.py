"""FastAPI application factory for the deepfreeze server."""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from deepfreeze_core.esclient import apply_storage_credentials, create_es_client

from .api import actions, events, health, jobs, login, scheduler, status
from .api.auth import AuthMiddleware
from .config import ServerConfig, get_elasticsearch_config, load_server_config
from .orchestration.orchestrator import DeepfreezeOrchestrator

# Paths that should never fall through to the SPA catch-all
_API_PREFIXES = ("/api", "/health", "/ready", "/docs", "/openapi.json", "/redoc")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize orchestrator on startup, clean up on shutdown."""
    raw_config: dict = app.state.raw_config
    # Honor config.yml's storage block (shared with the CLI via core).
    apply_storage_credentials(raw_config)
    es_config = get_elasticsearch_config(raw_config)
    client = create_es_client(**es_config)

    server_cfg: ServerConfig = app.state.server_config
    orchestrator = DeepfreezeOrchestrator(
        client=client,
        refresh_interval=server_cfg.refresh_interval,
    )
    app.state.orchestrator = orchestrator
    await orchestrator.start(scheduled_jobs=server_cfg.scheduled_jobs)
    yield
    await orchestrator.stop()


def create_app(
    config_path: str | None = None,
    cors_origins: list[str] | None = None,
) -> FastAPI:
    """Create and configure the FastAPI application.

    Args:
        config_path: Path to deepfreeze config file.
        cors_origins: Allowed CORS origins. Defaults to ["*"].
    """
    server_config, raw_config = load_server_config(config_path)

    app = FastAPI(
        title="Deepfreeze Server",
        description="Deepfreeze persistent daemon — REST API, job management, and SSE events",
        version="2.0.0",
        lifespan=lifespan,
    )

    # Store config for lifespan (loaded once, reused)
    app.state.config_path = config_path
    app.state.server_config = server_config
    app.state.raw_config = raw_config
    app.state.auth_config = server_config.auth

    # Auth middleware — no-op when no tokens configured
    app.add_middleware(AuthMiddleware)

    # API routes
    app.include_router(health.router, tags=["health"])
    app.include_router(login.router, prefix="/api", tags=["auth"])
    app.include_router(status.router, prefix="/api", tags=["status"])
    app.include_router(actions.router, prefix="/api", tags=["actions"])
    app.include_router(jobs.router, prefix="/api", tags=["jobs"])
    app.include_router(events.router, prefix="/api", tags=["events"])
    app.include_router(scheduler.router, prefix="/api", tags=["scheduler"])

    # Serve React frontend (production) if it exists.
    # Check two locations:
    #   1. Inside the package (pip install): deepfreeze_server/static/
    #   2. Development (pip install -e): ../frontend/dist/
    frontend_build = Path(__file__).parent / "static"
    if not frontend_build.is_dir():
        frontend_build = Path(__file__).parent.parent / "frontend" / "dist"
    if frontend_build.is_dir():
        app.mount(
            "/assets",
            StaticFiles(directory=str(frontend_build / "assets")),
            name="assets",
        )
        index_html = frontend_build / "index.html"

        @app.get("/{full_path:path}")
        async def serve_spa(full_path: str):
            if full_path and any(
                full_path == p.lstrip("/") or full_path.startswith(p.lstrip("/") + "/")
                for p in _API_PREFIXES
            ):
                return FileResponse(index_html)  # let FastAPI 404 naturally
            file_path = frontend_build / full_path
            if full_path and file_path.is_file():
                return FileResponse(file_path)
            return FileResponse(index_html)

    # CORS
    origins = cors_origins or server_config.cors_origins
    if origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=False,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    return app
