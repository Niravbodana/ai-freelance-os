"""Agent Communication Bus.

All inter-agent messages travel through this bus as typed events.
Agents never call each other directly; they publish a message event
and any interested agent subscribes to it.

This bus is a thin façade over the application EventBus that adds
agent-specific routing, correlation tracking, and a simple request/
response (ask/answer) pattern for synchronous-style coordination.

Usage (publisher side)::
    bus = AgentBus(event_bus=get_event_bus())
    await bus.send(
        from_agent="ceo",
        to_agent="operations_manager",
        message_type="delegate_task",
        payload={"task_id": "...", "goal": "..."},
    )

Usage (subscriber side)::
    async def handle_delegation(msg: AgentMessage) -> None:
        ...

    bus.subscribe(agent_name="operations_manager", handler=handle_delegation)
"""
from __future__ import annotations

import asyncio
import contextlib
from collections import defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from backend.app.core.events import Event, EventBus
from backend.app.core.logging import get_logger

logger = get_logger(__name__)

AgentMessageHandler = Callable[["AgentMessage"], Awaitable[None]]


# ── Message envelope ──────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class AgentMessage:
    """Typed inter-agent message routed through the event bus."""

    from_agent: str
    to_agent: str
    message_type: str
    payload: dict[str, Any]
    message_id: str = field(default_factory=lambda: str(uuid4()))
    correlation_id: str | None = None
    reply_to: str | None = None
    sent_at: datetime = field(default_factory=lambda: datetime.now(tz=UTC))

    def to_event_payload(self) -> dict[str, Any]:
        return {
            "message_id": self.message_id,
            "from_agent": self.from_agent,
            "to_agent": self.to_agent,
            "message_type": self.message_type,
            "payload": self.payload,
            "correlation_id": self.correlation_id,
            "reply_to": self.reply_to,
            "sent_at": self.sent_at.isoformat(),
        }

    @classmethod
    def from_event(cls, event: Event) -> AgentMessage:
        p = event.payload
        return cls(
            from_agent=p["from_agent"],
            to_agent=p["to_agent"],
            message_type=p["message_type"],
            payload=p["payload"],
            message_id=p.get("message_id", str(uuid4())),
            correlation_id=p.get("correlation_id"),
            reply_to=p.get("reply_to"),
            sent_at=(
                datetime.fromisoformat(p["sent_at"]) if "sent_at" in p else datetime.now(tz=UTC)
            ),
        )


# ── Reply futures ─────────────────────────────────────────────────────────────


@dataclass
class _PendingReply:
    future: asyncio.Future[AgentMessage]
    timeout: float


# ── Agent Communication Bus ───────────────────────────────────────────────────


_AGENT_MESSAGE_EVENT = "agent.message"


class AgentBus:
    """
    Routes typed messages between agents via the event bus.

    Supports:
    - fire-and-forget ``send()``
    - request/response ``ask()`` with a configurable timeout
    - per-agent subscription with typed handlers
    """

    def __init__(self, event_bus: EventBus) -> None:
        self._bus = event_bus
        self._handlers: dict[str, list[AgentMessageHandler]] = defaultdict(list)
        self._pending_replies: dict[str, _PendingReply] = {}
        # Register a single internal listener on the underlying event bus.
        self._bus.subscribe(_AGENT_MESSAGE_EVENT, self._dispatch_to_handlers)

    def subscribe(self, agent_name: str, handler: AgentMessageHandler) -> None:
        """Register *handler* to receive messages addressed to *agent_name*."""
        self._handlers[agent_name].append(handler)
        logger.debug("agent_bus.subscribed", agent=agent_name, handler=handler.__qualname__)

    def unsubscribe(self, agent_name: str, handler: AgentMessageHandler) -> None:
        with contextlib.suppress(ValueError):
            self._handlers[agent_name].remove(handler)

    async def send(
        self,
        from_agent: str,
        to_agent: str,
        message_type: str,
        payload: dict[str, Any],
        *,
        correlation_id: str | None = None,
        reply_to: str | None = None,
    ) -> AgentMessage:
        """Publish a message on the bus; returns the sent AgentMessage."""
        msg = AgentMessage(
            from_agent=from_agent,
            to_agent=to_agent,
            message_type=message_type,
            payload=payload,
            correlation_id=correlation_id,
            reply_to=reply_to,
        )
        await self._bus.emit(
            _AGENT_MESSAGE_EVENT,
            payload=msg.to_event_payload(),
            source=from_agent,
            correlation_id=correlation_id,
        )
        logger.debug(
            "agent_bus.sent",
            from_agent=from_agent,
            to_agent=to_agent,
            message_type=message_type,
            message_id=msg.message_id,
        )
        return msg

    async def ask(
        self,
        from_agent: str,
        to_agent: str,
        message_type: str,
        payload: dict[str, Any],
        timeout: float = 30.0,
    ) -> AgentMessage:
        """
        Send a message and await a reply with the same correlation_id.

        The receiving agent must call ``reply()`` for this to resolve.
        Raises asyncio.TimeoutError if no reply arrives within *timeout* seconds.
        """
        correlation_id = str(uuid4())
        loop = asyncio.get_event_loop()
        future: asyncio.Future[AgentMessage] = loop.create_future()
        self._pending_replies[correlation_id] = _PendingReply(future=future, timeout=timeout)

        try:
            await self.send(
                from_agent=from_agent,
                to_agent=to_agent,
                message_type=message_type,
                payload=payload,
                correlation_id=correlation_id,
                reply_to=from_agent,
            )
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._pending_replies.pop(correlation_id, None)

    async def reply(self, original: AgentMessage, payload: dict[str, Any]) -> None:
        """Send a reply to *original*. Resolves the pending ask() future."""
        if original.reply_to is None:
            return
        await self.send(
            from_agent=original.to_agent,
            to_agent=original.reply_to,
            message_type=f"{original.message_type}.reply",
            payload=payload,
            correlation_id=original.correlation_id,
        )

    async def _dispatch_to_handlers(self, event: Event) -> None:
        msg = AgentMessage.from_event(event)

        # Resolve pending ask() futures first.
        if msg.correlation_id and msg.correlation_id in self._pending_replies:
            pending = self._pending_replies[msg.correlation_id]
            if not pending.future.done():
                pending.future.set_result(msg)
                return

        handlers = self._handlers.get(msg.to_agent, [])
        if not handlers:
            logger.debug("agent_bus.no_handlers", to_agent=msg.to_agent)
            return

        tasks = [asyncio.create_task(h(msg)) for h in handlers]
        await asyncio.gather(*tasks, return_exceptions=True)


# ── Singleton ─────────────────────────────────────────────────────────────────

_agent_bus: AgentBus | None = None


def get_agent_bus() -> AgentBus:
    """Return the application-wide AgentBus singleton."""
    global _agent_bus
    if _agent_bus is None:
        from backend.app.core.events import get_event_bus

        _agent_bus = AgentBus(event_bus=get_event_bus())
    return _agent_bus
