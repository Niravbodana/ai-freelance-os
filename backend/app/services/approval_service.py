"""Human-in-the-loop approval service.

The approval engine is channel-agnostic. Notification channels (REST API,
WhatsApp, email, mobile app, etc.) plug in by implementing ApprovalChannel
and registering themselves with the ApprovalService. The core engine never
depends on a specific delivery mechanism.
"""
from __future__ import annotations

import abc
import asyncio
import json
from collections.abc import Sequence
from typing import Any

import ulid
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import settings
from backend.app.core.exceptions import ApprovalTimeoutError, NotFoundError
from backend.app.core.logging import get_logger
from backend.app.core.metrics import (
    APPROVAL_WAIT_TIME,
    APPROVALS_GRANTED,
    APPROVALS_PENDING,
    APPROVALS_REJECTED,
    APPROVALS_REQUESTED,
)
from backend.app.models.approval import Approval, ApprovalStatus
from backend.app.models.task import Task, TaskStatus
from backend.app.schemas.approval import ApprovalDecision

logger = get_logger(__name__)


# ── Channel interface ─────────────────────────────────────────────────────────


class ApprovalChannel(abc.ABC):
    """
    Abstract delivery channel for approval notifications.

    Implement this interface to add a new delivery mechanism
    (REST polling, WhatsApp, email, push notification, etc.).
    Register an instance via ApprovalService.register_channel().
    """

    @property
    @abc.abstractmethod
    def channel_name(self) -> str:
        """Unique identifier for this channel, e.g. 'rest', 'whatsapp'."""
        ...

    @abc.abstractmethod
    async def notify(self, approval: Approval, context: dict[str, Any] | None = None) -> None:
        """Send the approval request through this channel."""
        ...

    @abc.abstractmethod
    async def notify_decision(
        self, approval: Approval, approved: bool, note: str | None = None
    ) -> None:
        """Notify interested parties that a decision was made."""
        ...


# ── Built-in REST channel (logs only; no external side-effects) ───────────────


class RestApprovalChannel(ApprovalChannel):
    """
    Default approval channel: logs the request and relies on the REST API
    (/approvals) for the actual human decision.
    """

    channel_name = "rest"

    async def notify(self, approval: Approval, context: dict[str, Any] | None = None) -> None:
        logger.info(
            "approval.channel.rest.notify",
            approval_id=approval.id,
            action=approval.action,
            context_summary=str(context)[:200] if context else None,
        )

    async def notify_decision(
        self, approval: Approval, approved: bool, note: str | None = None
    ) -> None:
        logger.info(
            "approval.channel.rest.decision",
            approval_id=approval.id,
            approved=approved,
            note=note,
        )


# ── Service ───────────────────────────────────────────────────────────────────


class ApprovalService:
    """
    Manages the full approval lifecycle.

    - request_approval(): create an Approval record and notify all channels.
    - decide():           record the human decision and notify channels.
    - wait_for_decision(): block (with timeout) until a decision is recorded.
    - list_pending():     return all open approvals.
    """

    def __init__(self, db: AsyncSession) -> None:
        self._db = db
        self._channels: dict[str, ApprovalChannel] = {
            "rest": RestApprovalChannel(),
        }

    # ── Channel management ────────────────────────────────────────────────────

    def register_channel(self, channel: ApprovalChannel) -> None:
        """Plug in a new delivery channel."""
        self._channels[channel.channel_name] = channel
        logger.info("approval_service.channel_registered", channel=channel.channel_name)

    def unregister_channel(self, channel_name: str) -> None:
        self._channels.pop(channel_name, None)

    # ── Core operations ───────────────────────────────────────────────────────

    async def request_approval(
        self,
        task_id: str,
        action: str,
        context: dict[str, Any] | None = None,
    ) -> Approval:
        """Create an approval request and notify all registered channels."""
        task = await self._db.get(Task, task_id)
        if task:
            task.status = TaskStatus.WAITING_FOR_APPROVAL

        approval = Approval(
            id=str(ulid.new()),
            task_id=task_id,
            action=action,
            context_json=json.dumps(context) if context else None,
            status=ApprovalStatus.PENDING,
        )
        self._db.add(approval)
        await self._db.flush()

        APPROVALS_REQUESTED.labels(action=action).inc()
        APPROVALS_PENDING.inc()
        logger.info("approval.requested", approval_id=approval.id, action=action)

        # Notify all registered channels concurrently.
        notify_tasks = [ch.notify(approval, context) for ch in self._channels.values()]
        await asyncio.gather(*notify_tasks, return_exceptions=True)

        # Emit event
        try:
            from backend.app.core.events import EventType, get_event_bus

            await get_event_bus().emit(
                EventType.APPROVAL_REQUESTED,
                payload={"approval_id": approval.id, "task_id": task_id, "action": action},
                source="approval_service",
            )
        except Exception:
            pass  # Non-critical; never block core flow

        return approval

    async def decide(self, approval_id: str, decision: ApprovalDecision) -> Approval:
        """Record a human decision on an approval request."""
        approval = await self._db.get(Approval, approval_id)
        if approval is None:
            raise NotFoundError("Approval", approval_id)

        if approval.status != ApprovalStatus.PENDING:
            raise ValueError(f"Approval '{approval_id}' is already {approval.status}")

        approval.status = ApprovalStatus.APPROVED if decision.approved else ApprovalStatus.REJECTED
        approval.reviewer_note = decision.reviewer_note
        await self._db.flush()

        APPROVALS_PENDING.dec()
        if decision.approved:
            APPROVALS_GRANTED.labels(action=approval.action).inc()
        else:
            APPROVALS_REJECTED.labels(action=approval.action).inc()

        logger.info(
            "approval.decided",
            approval_id=approval_id,
            approved=decision.approved,
        )

        # Notify channels about the decision.
        notify_tasks = [
            ch.notify_decision(approval, decision.approved, decision.reviewer_note)
            for ch in self._channels.values()
        ]
        await asyncio.gather(*notify_tasks, return_exceptions=True)

        # Emit event
        try:
            from backend.app.core.events import EventType, get_event_bus

            event_type = (
                EventType.APPROVAL_GRANTED if decision.approved else EventType.APPROVAL_REJECTED
            )
            await get_event_bus().emit(
                event_type,
                payload={
                    "approval_id": approval_id,
                    "task_id": approval.task_id,
                    "action": approval.action,
                    "note": decision.reviewer_note,
                },
                source="approval_service",
            )
        except Exception:
            pass

        return approval

    async def wait_for_decision(
        self,
        approval_id: str,
        timeout: float | None = None,
        poll_interval: float = 2.0,
    ) -> Approval:
        """
        Poll the database until a decision is recorded or timeout elapses.

        This is a simple polling implementation. Production deployments may
        replace this with a Redis pub/sub or WebSocket push mechanism.
        """
        max_wait = timeout or settings.approval_timeout_seconds
        elapsed = 0.0

        with APPROVAL_WAIT_TIME.time():
            while elapsed < max_wait:
                approval = await self._db.get(Approval, approval_id)
                if approval is None:
                    raise NotFoundError("Approval", approval_id)
                if approval.status != ApprovalStatus.PENDING:
                    return approval

                await asyncio.sleep(poll_interval)
                elapsed += poll_interval

        # Expire the approval.
        approval = await self._db.get(Approval, approval_id)
        if approval and approval.status == ApprovalStatus.PENDING:
            approval.status = ApprovalStatus.EXPIRED
            await self._db.flush()
            APPROVALS_PENDING.dec()
            logger.warning("approval.expired", approval_id=approval_id)

            try:
                from backend.app.core.events import EventType, get_event_bus

                await get_event_bus().emit(
                    EventType.APPROVAL_EXPIRED,
                    payload={"approval_id": approval_id},
                    source="approval_service",
                )
            except Exception:
                pass

        raise ApprovalTimeoutError(approval_id)

    async def list_pending(self) -> Sequence[Approval]:
        result = await self._db.execute(
            select(Approval).where(Approval.status == ApprovalStatus.PENDING)
        )
        return result.scalars().all()
