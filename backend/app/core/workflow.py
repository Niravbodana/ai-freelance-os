"""Workflow Engine: manages task lifecycle state transitions.

Enforces the allowed state machine:
  CREATED → ANALYZING → WAITING_FOR_APPROVAL → APPROVED → ASSIGNED → RUNNING → QA → COMPLETED
                                                                                    ↘ FAILED
Any state may transition to FAILED or PAUSED.
PAUSED tasks can be resumed from any transient state.

Extended capabilities:
- Resume from FAILED state by re-entering the preceding active state.
- Pause any in-progress task and resume it later.
- Retry a transition up to *max_attempts* times with exponential back-off.
- Rollback a task to the previous valid state (stored in metadata).
- Workflow versioning via metadata tagging.
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
    TaskStatus.CREATED: frozenset({TaskStatus.ANALYZING, TaskStatus.FAILED, TaskStatus.PAUSED}),
    TaskStatus.ANALYZING: frozenset(
        {TaskStatus.WAITING_FOR_APPROVAL, TaskStatus.FAILED, TaskStatus.PAUSED}
    ),
    TaskStatus.WAITING_FOR_APPROVAL: frozenset(
        {TaskStatus.APPROVED, TaskStatus.FAILED, TaskStatus.PAUSED}
    ),
    TaskStatus.APPROVED: frozenset({TaskStatus.ASSIGNED, TaskStatus.FAILED, TaskStatus.PAUSED}),
    TaskStatus.ASSIGNED: frozenset({TaskStatus.RUNNING, TaskStatus.FAILED, TaskStatus.PAUSED}),
    TaskStatus.RUNNING: frozenset({TaskStatus.QA, TaskStatus.FAILED, TaskStatus.PAUSED}),
    TaskStatus.QA: frozenset(
        {TaskStatus.COMPLETED, TaskStatus.RUNNING, TaskStatus.FAILED, TaskStatus.PAUSED}
    ),
    TaskStatus.COMPLETED: frozenset(),
    TaskStatus.FAILED: frozenset({TaskStatus.ANALYZING}),  # resume entry point
    TaskStatus.PAUSED: frozenset(
        {
            TaskStatus.ANALYZING,
            TaskStatus.WAITING_FOR_APPROVAL,
            TaskStatus.APPROVED,
            TaskStatus.ASSIGNED,
            TaskStatus.RUNNING,
            TaskStatus.QA,
            TaskStatus.FAILED,
        }
    ),
}

# Map each terminal-before-failure status to the resume target.
# When a task is in FAILED, resume() re-enters ANALYZING so the workflow
# can be restarted from the analysis stage.
_RESUME_TARGET: TaskStatus = TaskStatus.ANALYZING

# States from which a task can be paused
_PAUSEABLE_STATES: frozenset[TaskStatus] = frozenset(
    {
        TaskStatus.CREATED,
        TaskStatus.ANALYZING,
        TaskStatus.WAITING_FOR_APPROVAL,
        TaskStatus.APPROVED,
        TaskStatus.ASSIGNED,
        TaskStatus.RUNNING,
        TaskStatus.QA,
    }
)

# States that are terminal (no further progress)
_TERMINAL_STATES: frozenset[TaskStatus] = frozenset(
    {TaskStatus.COMPLETED, TaskStatus.FAILED}
)


class WorkflowTransitionError(AppError):
    """Raised when a state transition is not permitted."""

    def __init__(self, from_state: TaskStatus, to_state: TaskStatus) -> None:
        super().__init__(
            f"Cannot transition task from '{from_state}' to '{to_state}'",
            "WORKFLOW_TRANSITION_ERROR",
        )
        self.from_state = from_state
        self.to_state = to_state


class WorkflowRollbackError(AppError):
    """Raised when a rollback cannot be performed."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"Workflow rollback failed: {reason}", "WORKFLOW_ROLLBACK_ERROR")


# ── Workflow Engine ───────────────────────────────────────────────────────────


class WorkflowEngine:
    """
    Governs task state transitions.

    Usage::
        engine = WorkflowEngine(db=session, event_bus=bus)
        await engine.transition(task, TaskStatus.ANALYZING)
        # pause a running task
        await engine.pause(task)
        # resume a paused task
        await engine.resume_paused(task)
        # resume a failed task
        await engine.resume(task)
        # rollback to previous state
        await engine.rollback(task)
        # transition with automatic retry
        await engine.transition_with_retry(task, TaskStatus.RUNNING)
    """

    # Metadata key used to store the previous state for rollback
    _PREV_STATE_KEY = "_prev_status"
    # Metadata key used to store workflow version
    _VERSION_KEY = "_workflow_version"

    def __init__(self, db: AsyncSession, event_bus: EventBus | None = None) -> None:
        self._db = db
        self._bus = event_bus

    async def transition(
        self,
        task: Task,
        new_status: TaskStatus,
        *,
        metadata: dict | None = None,
        workflow_version: str | None = None,
    ) -> Task:
        """Apply a state transition to *task*, persisting and publishing an event."""
        old_status = task.status
        self._validate(old_status, new_status)

        # Persist previous state in metadata for rollback support
        meta = dict(metadata or {})
        meta[self._PREV_STATE_KEY] = str(old_status)
        if workflow_version:
            meta[self._VERSION_KEY] = workflow_version

        task.status = new_status
        # Store metadata on task if it supports it
        if hasattr(task, "metadata_json"):
            import contextlib
            import json
            existing: dict = {}
            with contextlib.suppress(Exception):
                if task.metadata_json:
                    existing = json.loads(task.metadata_json)
            existing.update(meta)
            task.metadata_json = json.dumps(existing)

        await self._db.flush()

        logger.info(
            "workflow.transition",
            task_id=task.id,
            from_status=old_status,
            to_status=new_status,
            workflow_version=workflow_version,
        )

        if self._bus is not None:
            from backend.app.core.events import EventType

            await self._bus.emit(
                EventType.TASK_STATUS_CHANGED,
                payload={
                    "task_id": task.id,
                    "from_status": old_status,
                    "to_status": new_status,
                    "metadata": meta,
                },
                source="workflow_engine",
            )

        return task

    async def pause(
        self,
        task: Task,
        *,
        reason: str | None = None,
    ) -> Task:
        """Pause a task that is currently in a pauseable state.

        Raises WorkflowTransitionError if the task cannot be paused.
        """
        if task.status not in _PAUSEABLE_STATES:
            raise WorkflowTransitionError(task.status, TaskStatus.PAUSED)

        return await self.transition(
            task,
            TaskStatus.PAUSED,
            metadata={"pause_reason": reason or "manual_pause"},
        )

    async def resume_paused(
        self,
        task: Task,
        *,
        target_status: TaskStatus | None = None,
    ) -> Task:
        """Resume a PAUSED task.

        If *target_status* is provided, transitions to that state; otherwise
        restores the state the task was in before pausing (stored in metadata).

        Raises WorkflowTransitionError if the task is not in PAUSED state.
        """
        if task.status != TaskStatus.PAUSED:
            raise WorkflowTransitionError(task.status, TaskStatus.ANALYZING)

        if target_status is not None:
            resume_to = target_status
        else:
            # Try to restore from stored metadata
            resume_to = self._read_prev_state(task) or TaskStatus.ANALYZING

        return await self.transition(
            task,
            resume_to,
            metadata={"resumed_from": "paused"},
        )

    async def resume(
        self,
        task: Task,
        *,
        metadata: dict | None = None,
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

    async def rollback(
        self,
        task: Task,
        *,
        reason: str | None = None,
    ) -> Task:
        """Roll the task back to its previous state (stored in metadata).

        Raises WorkflowRollbackError if no previous state is available.
        Rollback bypasses normal state machine validation since it explicitly
        reverses to a known-good previous state.
        """
        prev = self._read_prev_state(task)
        if prev is None:
            raise WorkflowRollbackError("No previous state recorded in task metadata")

        try:
            prev_status = TaskStatus(prev)
        except ValueError as exc:
            raise WorkflowRollbackError(f"Invalid previous state value: '{prev}'") from exc

        old_status = task.status
        logger.info(
            "workflow.rollback",
            task_id=task.id,
            from_status=old_status,
            to_status=prev_status,
            reason=reason,
        )

        # Bypass state machine: rollback is always authorised
        task.status = prev_status
        import contextlib
        import json

        meta: dict = {}
        if hasattr(task, "metadata_json") and task.metadata_json:
            with contextlib.suppress(Exception):
                meta = json.loads(task.metadata_json)
        meta.update({
            "_prev_status": str(old_status),
            "rolled_back": True,
            "rollback_reason": reason or "",
        })
        task.metadata_json = json.dumps(meta)
        await self._db.flush()

        if self._bus is not None:
            from backend.app.core.events import EventType

            await self._bus.emit(
                EventType.TASK_STATUS_CHANGED,
                payload={
                    "task_id": task.id,
                    "from_status": old_status,
                    "to_status": prev_status,
                    "metadata": {"rolled_back": True},
                },
                source="workflow_engine",
            )

        return task

    async def transition_with_retry(
        self,
        task: Task,
        new_status: TaskStatus,
        *,
        max_attempts: int = 3,
        wait_min: float = 1.0,
        wait_max: float = 10.0,
        metadata: dict | None = None,
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

    def _read_prev_state(self, task: Task) -> str | None:
        """Read the stored previous state from task metadata."""
        if not hasattr(task, "metadata_json") or not task.metadata_json:
            return None
        import json
        try:
            data = json.loads(task.metadata_json)
            return data.get(self._PREV_STATE_KEY)
        except Exception:
            return None
