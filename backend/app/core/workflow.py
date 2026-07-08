"""Workflow Engine: manages task lifecycle state transitions.

Enforces the allowed state machine:
  CREATED → ANALYZING → WAITING_FOR_APPROVAL → APPROVED → ASSIGNED → RUNNING → QA → COMPLETED
                                                                                    ↘ FAILED
Any state may transition to FAILED.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from backend.app.core.exceptions import AppError
from backend.app.core.logging import get_logger
from backend.app.models.task import TaskStatus

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from backend.app.core.events import EventBus
    from backend.app.models.task import Task

logger = get_logger(__name__)

# ── Allowed transitions ───────────────────────────────────────────────────────

_TRANSITIONS: dict[TaskStatus, frozenset[TaskStatus]] = {
    TaskStatus.CREATED: frozenset({TaskStatus.ANALYZING, TaskStatus.FAILED}),
    TaskStatus.ANALYZING: frozenset({TaskStatus.WAITING_FOR_APPROVAL, TaskStatus.FAILED}),
    TaskStatus.WAITING_FOR_APPROVAL: frozenset({TaskStatus.APPROVED, TaskStatus.FAILED}),
    TaskStatus.APPROVED: frozenset({TaskStatus.ASSIGNED, TaskStatus.FAILED}),
    TaskStatus.ASSIGNED: frozenset({TaskStatus.RUNNING, TaskStatus.FAILED}),
    TaskStatus.RUNNING: frozenset({TaskStatus.QA, TaskStatus.FAILED}),
    TaskStatus.QA: frozenset({TaskStatus.COMPLETED, TaskStatus.RUNNING, TaskStatus.FAILED}),
    TaskStatus.COMPLETED: frozenset(),
    TaskStatus.FAILED: frozenset(),
}


class WorkflowTransitionError(AppError):
    """Raised when a state transition is not permitted."""

    def __init__(self, from_state: TaskStatus, to_state: TaskStatus) -> None:
        super().__init__(
            f"Cannot transition task from '{from_state}' to '{to_state}'",
            "WORKFLOW_TRANSITION_ERROR",
        )
        self.from_state = from_state
        self.to_state = to_state


# ── Workflow Engine ───────────────────────────────────────────────────────────


class WorkflowEngine:
    """
    Governs task state transitions.

    Usage::
        engine = WorkflowEngine(db=session, event_bus=bus)
        await engine.transition(task, TaskStatus.ANALYZING)
    """

    def __init__(self, db: AsyncSession, event_bus: EventBus | None = None) -> None:
        self._db = db
        self._bus = event_bus

    async def transition(
        self,
        task: Task,
        new_status: TaskStatus,
        *,
        metadata: dict[str, object] | None = None,
    ) -> Task:
        """Apply a state transition to *task*, persisting and publishing an event."""
        old_status = task.status
        self._validate(old_status, new_status)

        task.status = new_status
        await self._db.flush()

        logger.info(
            "workflow.transition",
            task_id=task.id,
            from_status=old_status,
            to_status=new_status,
        )

        if self._bus is not None:
            from backend.app.core.events import EventType

            await self._bus.emit(
                EventType.TASK_STATUS_CHANGED,
                payload={
                    "task_id": task.id,
                    "from_status": old_status,
                    "to_status": new_status,
                    "metadata": metadata or {},
                },
                source="workflow_engine",
            )

        return task

    def can_transition(self, from_status: TaskStatus, to_status: TaskStatus) -> bool:
        """Return True if the transition is permitted."""
        return to_status in _TRANSITIONS.get(from_status, frozenset())

    def allowed_next(self, current_status: TaskStatus) -> frozenset[TaskStatus]:
        """Return the set of valid next statuses for *current_status*."""
        return _TRANSITIONS.get(current_status, frozenset())

    def _validate(self, from_status: TaskStatus, to_status: TaskStatus) -> None:
        if not self.can_transition(from_status, to_status):
            raise WorkflowTransitionError(from_status, to_status)
