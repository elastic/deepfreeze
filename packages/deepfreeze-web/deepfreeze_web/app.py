"""FastAPI application for deepfreeze Web UI."""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from deepfreeze_service import DeepfreezeService, PollingConfig

from .routes import actions, status


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize and clean up the deepfreeze service."""
    config_path = app.state.config_path
    service = DeepfreezeService(
        config_path=config_path,
        polling_config=PollingConfig(enabled=True, interval_seconds=30),
    )
    app.state.service = service
    yield
    # Cleanup (if needed)


def create_app(
    config_path: str | None = None,
    cors_origins: list[str] | None = None,
) -> FastAPI:
    """Create and configure the FastAPI application.

    Args:
        config_path: Path to deepfreeze config file.
        cors_origins: Allowed CORS origins. Pass an empty list to disable CORS
                      (production mode where frontend is served by FastAPI).
                      Defaults to allowing the Vite dev server origin.
    """
    app = FastAPI(
        title="Deepfreeze",
        description="Web UI for deepfreeze - Elasticsearch S3 Glacier archive management",
        version="1.0.0",
        lifespan=lifespan,
    )

    # Store config path for lifespan
    app.state.config_path = config_path

    # API routes
    app.include_router(status.router, prefix="/api", tags=["status"])
    app.include_router(actions.router, prefix="/api", tags=["actions"])

    # Serve React build (production) if it exists
    frontend_build = Path(__file__).parent.parent / "frontend" / "dist"
    serving_frontend = frontend_build.is_dir()
    if serving_frontend:
        app.mount("/", StaticFiles(directory=str(frontend_build), html=True))

    # CORS — default to allowing all origins (no auth in this app).
    # Override with --cors-origin to restrict, or pass [] to disable.
    if cors_origins is None:
        cors_origins = ["*"]
    if cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_credentials=False,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    return app
