"""Workflow Engine: manages task lifecycle state transitions.

Enforces the allowed state machine:
  CREATED → ANALYZING → WAITING_FOR_APPROVAL → APPROVED → ASSIGNED → RUNNING → QA → COMPLETED
                                                                                    ↘ FAILED
Any state may transition to FAILED.

Extended capabilities:
- Resume from FAILED state by re-entering the preceding active state.
- Retry a transition up to *max_attempts* times with exponential back-off.
"""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from tenacity import AsyncRetrying, retry_if_exception_type, stop_after_attempt, wait_exponential

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
    TaskStatus.FAILED: frozenset({TaskStatus.ANALYZING}),  # resume entry point
}

# Map each terminal-before-failure status to the resume target.
# When a task is in FAILED, resume() re-enters ANALYZING so the workflow
# can be restarted from the analysis stage.
_RESUME_TARGET: TaskStatus = TaskStatus.ANALYZING


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
        # resume a failed task
        await engine.resume(task)
        # transition with automatic retry
        await engine.transition_with_retry(task, TaskStatus.RUNNING)
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

    async def resume(
        self,
        task: Task,
        *,
        metadata: dict[str, object] | None = None,
    ) -> Task:
        """Resume a FAILED task by re-entering the workflow at the analysis stage.

        Raises WorkflowTransitionError if the task is not in FAILED state.
        """
        if task.status != TaskStatus.FAILED:
            raise WorkflowTransitionError(task.status, _RESUME_TARGET)

        logger.info("workflow.resume", task_id=task.id, resume_target=_RESUME_TARGET)
        return await self.transition(
            task,
            _RESUME_TARGET,
            metadata={"resumed": True, **(metadata or {})},
        )

    async def transition_with_retry(
        self,
        task: Task,
        new_status: TaskStatus,
        *,
        max_attempts: int = 3,
        wait_min: float = 1.0,
        wait_max: float = 10.0,
        metadata: dict[str, object] | None = None,
    ) -> Task:
        """Attempt a transition, retrying on transient errors.

        Only retries on :class:`OSError` and :class:`asyncio.TimeoutError` so
        that :class:`WorkflowTransitionError` (invalid state) is never retried.
        """
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(max_attempts),
            wait=wait_exponential(min=wait_min, max=wait_max),
            retry=retry_if_exception_type((OSError, asyncio.TimeoutError)),
            reraise=True,
        ):
            with attempt:
                return await self.transition(task, new_status, metadata=metadata)
        raise RuntimeError("transition_with_retry exited without result")  # pragma: no cover

    def can_transition(self, from_status: TaskStatus, to_status: TaskStatus) -> bool:
        """Return True if the transition is permitted."""
        return to_status in _TRANSITIONS.get(from_status, frozenset())

    def allowed_next(self, current_status: TaskStatus) -> frozenset[TaskStatus]:
        """Return the set of valid next statuses for *current_status*."""
        return _TRANSITIONS.get(current_status, frozenset())

    def _validate(self, from_status: TaskStatus, to_status: TaskStatus) -> None:
        if not self.can_transition(from_status, to_status):
            raise WorkflowTransitionError(from_status, to_status)
