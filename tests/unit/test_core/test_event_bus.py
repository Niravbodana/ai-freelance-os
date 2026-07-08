"""Tests for EventBus: publish, subscribe, dead-letter, and persistence."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.app.core.events import Event, EventBus, EventStore, EventType


@pytest.fixture()
def bus() -> EventBus:
    return EventBus()


class TestSubscribePublish:
    async def test_handler_called_on_matching_event(self, bus: EventBus) -> None:
        received: list[Event] = []

        async def handler(e: Event) -> None:
            received.append(e)

        bus.subscribe(EventType.TASK_CREATED, handler)
        await bus.emit(EventType.TASK_CREATED, payload={"task_id": "1"})
        assert len(received) == 1
        assert received[0].event_type == EventType.TASK_CREATED

    async def test_wildcard_subscription(self, bus: EventBus) -> None:
        received: list[Event] = []

        async def handler(e: Event) -> None:
            received.append(e)

        bus.subscribe("task.*", handler)
        await bus.emit(EventType.TASK_CREATED, payload={})
        await bus.emit(EventType.TASK_COMPLETED, payload={})
        await bus.emit(EventType.AGENT_COMPLETED, payload={})
        assert len(received) == 2

    async def test_unsubscribe_removes_handler(self, bus: EventBus) -> None:
        received: list[Event] = []

        async def handler(e: Event) -> None:
            received.append(e)

        bus.subscribe(EventType.TASK_CREATED, handler)
        bus.unsubscribe(EventType.TASK_CREATED, handler)
        await bus.emit(EventType.TASK_CREATED, payload={})
        assert len(received) == 0

    async def test_no_handlers_emits_no_error(self, bus: EventBus) -> None:
        # Should not raise
        await bus.emit(EventType.TASK_CREATED, payload={})

    async def test_multiple_handlers_all_called(self, bus: EventBus) -> None:
        calls = []

        async def h1(e: Event) -> None:
            calls.append("h1")

        async def h2(e: Event) -> None:
            calls.append("h2")

        bus.subscribe(EventType.TASK_CREATED, h1)
        bus.subscribe(EventType.TASK_CREATED, h2)
        await bus.emit(EventType.TASK_CREATED, payload={})
        assert "h1" in calls
        assert "h2" in calls


class TestDeadLetter:
    async def test_failing_handler_goes_to_dead_letter(self, bus: EventBus) -> None:
        async def bad_handler(e: Event) -> None:
            raise ValueError("boom")

        bus.subscribe(EventType.TASK_CREATED, bad_handler)
        await bus.emit(EventType.TASK_CREATED, payload={})
        dead = bus.drain_dead_letter()
        assert len(dead) == 1
        assert isinstance(dead[0][1], ValueError)

    async def test_drain_clears_dead_letter(self, bus: EventBus) -> None:
        async def bad_handler(e: Event) -> None:
            raise RuntimeError("oops")

        bus.subscribe(EventType.TASK_CREATED, bad_handler)
        await bus.emit(EventType.TASK_CREATED, payload={})
        bus.drain_dead_letter()
        assert bus.drain_dead_letter() == []


class TestEventPersistence:
    async def test_store_save_called_on_emit(self, bus: EventBus) -> None:
        store = MagicMock(spec=EventStore)
        store.save = AsyncMock()
        bus.set_store(store)
        await bus.emit(EventType.TASK_CREATED, payload={"task_id": "x"})
        store.save.assert_called_once()
        saved_event: Event = store.save.call_args[0][0]
        assert saved_event.event_type == EventType.TASK_CREATED

    async def test_store_error_does_not_prevent_handlers(self, bus: EventBus) -> None:
        store = MagicMock(spec=EventStore)
        store.save = AsyncMock(side_effect=RuntimeError("redis down"))
        bus.set_store(store)

        received: list[Event] = []

        async def handler(e: Event) -> None:
            received.append(e)

        bus.subscribe(EventType.TASK_CREATED, handler)
        await bus.emit(EventType.TASK_CREATED, payload={})
        # Handler still fires despite store failure
        assert len(received) == 1
