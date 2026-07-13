"""In-process pub/sub event bus for SSE delivery."""

import asyncio
import logging
from collections.abc import AsyncIterator

from ..models.events import Event, EventChannel

logger = logging.getLogger("deepfreeze.server.eventbus")

# Maximum events buffered per subscriber before dropping
MAX_QUEUE_SIZE = 256


class EventBus:
    """In-process event bus with async subscriber queues.

    Publishes events to all connected subscribers. Each subscriber gets its
    own bounded asyncio.Queue. Slow consumers have events dropped to prevent
    back-pressure from blocking the publisher.
    """

    def __init__(self) -> None:
        self._subscribers: dict[int, asyncio.Queue[Event]] = {}
        self._next_id = 0
        self._lock = asyncio.Lock()

    async def subscribe(
        self, channel: EventChannel | None = None
    ) -> AsyncIterator[Event]:
        """Subscribe to events, optionally filtered by channel.

        Yields events as they arrive. Automatically unsubscribes on exit.
        """
        sub_id, queue = await self._add_subscriber()
        try:
            while True:
                event = await queue.get()
                if channel is None or event.channel == channel:
                    yield event
        except asyncio.CancelledError:
            pass
        finally:
            await self._remove_subscriber(sub_id)

    async def publish(self, event: Event) -> None:
        """Publish an event to all subscribers."""
        # Snapshot subscribers under lock, then fan out without holding it
        async with self._lock:
            subscribers = dict(self._subscribers)

        dropped = 0
        for sub_id, queue in subscribers.items():
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                dropped += 1
                # Drop oldest event to make room
                try:
                    queue.get_nowait()
                    queue.put_nowait(event)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass
        if dropped:
            logger.warning("Dropped events for %d slow subscriber(s)", dropped)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    async def _add_subscriber(self) -> tuple[int, asyncio.Queue[Event]]:
        async with self._lock:
            sub_id = self._next_id
            self._next_id += 1
            queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=MAX_QUEUE_SIZE)
            self._subscribers[sub_id] = queue
            logger.debug("Subscriber %d connected (%d total)", sub_id, len(self._subscribers))
            return sub_id, queue

    async def _remove_subscriber(self, sub_id: int) -> None:
        async with self._lock:
            self._subscribers.pop(sub_id, None)
            logger.debug("Subscriber %d disconnected (%d total)", sub_id, len(self._subscribers))
