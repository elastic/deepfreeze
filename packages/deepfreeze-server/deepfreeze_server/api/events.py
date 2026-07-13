"""Server-Sent Events (SSE) endpoint."""

import json

from fastapi import APIRouter, Depends
from sse_starlette.sse import EventSourceResponse

from ..models.events import EventChannel
from ..orchestration.orchestrator import DeepfreezeOrchestrator
from .deps import get_orchestrator

router = APIRouter()


@router.get("/events")
async def event_stream(
    channel: str | None = None,
    orch: DeepfreezeOrchestrator = Depends(get_orchestrator),
):
    """Subscribe to server-sent events.

    Optional channel filter: jobs, status, thaw, scheduler.
    Without a filter, all events are delivered.
    """
    filter_channel = EventChannel(channel) if channel else None

    async def generate():
        async for event in orch.event_bus.subscribe(channel=filter_channel):
            yield {
                "event": event.type.value,
                "data": json.dumps(event.data),
            }

    return EventSourceResponse(
        generate(),
        ping=30,
    )
