"""Shared FastAPI dependencies."""

from fastapi import Request

from ..orchestration.orchestrator import DeepfreezeOrchestrator


def get_orchestrator(request: Request) -> DeepfreezeOrchestrator:
    """FastAPI dependency that returns the orchestrator from app state."""
    return request.app.state.orchestrator
