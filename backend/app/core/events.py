"""Event-driven architecture: in-process async event bus.

All agents and services communicate through events rather than direct calls.
The bus supports typed events, wildcard subscriptions, and dead-letter handling.
"""
from __future__ import annotations

import asyncio
import contextlib
from collections import defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from uuid import uuid4

from backend.app.core.logging import get_logger

logger = get_logger(__name__)

# ── Event types ──────────────────────────────────────────────────────────────


class EventType(StrEnum):
    # Task lifecycle
    TASK_CREATED = "task.created"
    TASK_STATUS_CHANGED = "task.status_changed"
    TASK_ASSIGNED = "task.assigned"
    TASK_COMPLETED = "task.completed"
    TASK_FAILED = "task.failed"

    # Agent lifecycle
    AGENT_STARTED = "agent.started"
    AGENT_COMPLETED = "agent.completed"
    AGENT_FAILED = "agent.failed"

    # Approval lifecycle
    APPROVAL_REQUESTED = "approval.requested"
    APPROVAL_GRANTED = "approval.granted"
    APPROVAL_REJECTED = "approval.rejected"
    APPROVAL_EXPIRED = "approval.expired"

    # Memory
    MEMORY_WRITTEN = "memory.written"

    # Queue
    QUEUE_JOB_ENQUEUED = "queue.job_enqueued"
    QUEUE_JOB_STARTED = "queue.job_started"
    QUEUE_JOB_COMPLETED = "queue.job_completed"
    QUEUE_JOB_FAILED = "queue.job_failed"

    # Plugin
    PLUGIN_LOADED = "plugin.loaded"
    PLUGIN_UNLOADED = "plugin.unloaded"


# ── Event envelope ───────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Event:
    """Immutable event envelope carried on the bus."""

    event_type: str
    payload: dict[str, Any]
    event_id: str = field(default_factory=lambda: str(uuid4()))
    occurred_at: datetime = field(default_factory=lambda: datetime.now(tz=UTC))
    source: str = "system"
    correlation_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "event_type": self.event_type,
            "payload": self.payload,
            "occurred_at": self.occurred_at.isoformat(),
            "source": self.source,
            "correlation_id": self.correlation_id,
        }


# ── Handler protocol ─────────────────────────────────────────────────────────

EventHandler = Callable[[Event], Awaitable[None]]

# ── Event Bus ────────────────────────────────────────────────────────────────


class EventBus:
    """
    Async in-process event bus.

    Supports:
    - Exact event-type subscriptions.
    - Wildcard prefix subscriptions (e.g. "task.*" matches all task events).
    - Dead-letter queue for handlers that raise unhandled exceptions.
    """

    def __init__(self) -> None:
        self._handlers: dict[str, list[EventHandler]] = defaultdict(list)
        self._dead_letter: list[tuple[Event, Exception]] = []

    def subscribe(self, event_type: str, handler: EventHandler) -> None:
        """Register *handler* for *event_type* (exact or wildcard prefix ending with *)."""
        self._handlers[event_type].append(handler)
        logger.debug("event_bus.subscribed", event_type=event_type, handler=handler.__qualname__)

    def unsubscribe(self, event_type: str, handler: EventHandler) -> None:
        """Remove a previously registered handler."""
        with contextlib.suppress(ValueError):
            self._handlers[event_type].remove(handler)

    async def publish(self, event: Event) -> None:
        """Publish an event; invoke all matching handlers concurrently."""
        handlers = self._collect_handlers(event.event_type)
        if not handlers:
            logger.debug("event_bus.no_handlers", event_type=event.event_type)
            return

        logger.debug(
            "event_bus.publishing",
            event_type=event.event_type,
            event_id=event.event_id,
            handler_count=len(handlers),
        )

        tasks = [asyncio.create_task(self._invoke(h, event)) for h in handlers]
        await asyncio.gather(*tasks, return_exceptions=True)

    async def emit(
        self,
        event_type: str,
        payload: dict[str, Any],
        *,
        source: str = "system",
        correlation_id: str | None = None,
    ) -> Event:
        """Convenience method: build an Event and publish it."""
        event = Event(
            event_type=event_type,
            payload=payload,
            source=source,
            correlation_id=correlation_id,
        )
        await self.publish(event)
        return event

    def _collect_handlers(self, event_type: str) -> list[EventHandler]:
        handlers: list[EventHandler] = list(self._handlers.get(event_type, []))
        # Wildcard: check registered patterns that end with '*'
        for pattern, pattern_handlers in self._handlers.items():
            if pattern.endswith("*") and event_type.startswith(pattern[:-1]):
                handlers.extend(pattern_handlers)
        return handlers

    async def _invoke(self, handler: EventHandler, event: Event) -> None:
        try:
            await handler(event)
        except Exception as exc:
            logger.error(
                "event_bus.handler_error",
                handler=handler.__qualname__,
                event_type=event.event_type,
                event_id=event.event_id,
                error=str(exc),
            )
            self._dead_letter.append((event, exc))

    def drain_dead_letter(self) -> list[tuple[Event, Exception]]:
        """Return and clear the dead-letter queue."""
        items = list(self._dead_letter)
        self._dead_letter.clear()
        return items


# ── Singleton bus ─────────────────────────────────────────────────────────────

_bus: EventBus | None = None


def get_event_bus() -> EventBus:
    """Return the application-wide EventBus singleton."""
    global _bus
    if _bus is None:
        _bus = EventBus()
    return _bus
