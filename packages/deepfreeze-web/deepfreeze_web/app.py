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


def create_app(config_path: str | None = None) -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title="Deepfreeze",
        description="Web UI for deepfreeze - Elasticsearch S3 Glacier archive management",
        version="1.0.0",
        lifespan=lifespan,
    )

    # Store config path for lifespan
    app.state.config_path = config_path

    # CORS - allow all origins (no auth in MVP)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # API routes
    app.include_router(status.router, prefix="/api", tags=["status"])
    app.include_router(actions.router, prefix="/api", tags=["actions"])

    # Serve React build (production) if it exists
    frontend_build = Path(__file__).parent.parent / "frontend" / "dist"
    if frontend_build.is_dir():
        app.mount("/", StaticFiles(directory=str(frontend_build), html=True))

    return app
