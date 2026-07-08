"""Tests for WorkflowEngine: transitions, resume, and retry."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.app.core.workflow import (
    WorkflowEngine,
    WorkflowRollbackError,
    WorkflowTransitionError,
)
from backend.app.models.task import Task, TaskPriority, TaskStatus


def _make_task(status: TaskStatus, metadata_json: str | None = None) -> MagicMock:
    task = MagicMock(spec=Task)
    task.id = "task-1"
    task.status = status
    task.title = "Test task"
    task.description = "desc"
    task.priority = TaskPriority.MEDIUM
    task.metadata_json = metadata_json
    return task


@pytest.fixture()
def db() -> AsyncMock:
    db = AsyncMock()
    db.flush = AsyncMock()
    return db


@pytest.fixture()
def engine(db: AsyncMock) -> WorkflowEngine:
    return WorkflowEngine(db=db)


class TestTransition:
    async def test_valid_transition(self, engine: WorkflowEngine, db: AsyncMock) -> None:
        task = _make_task(TaskStatus.CREATED)
        result = await engine.transition(task, TaskStatus.ANALYZING)
        assert result.status == TaskStatus.ANALYZING
        db.flush.assert_called_once()

    async def test_invalid_transition_raises(self, engine: WorkflowEngine) -> None:
        task = _make_task(TaskStatus.CREATED)
        with pytest.raises(WorkflowTransitionError) as exc_info:
            await engine.transition(task, TaskStatus.COMPLETED)
        assert exc_info.value.from_state == TaskStatus.CREATED
        assert exc_info.value.to_state == TaskStatus.COMPLETED

    async def test_transition_emits_event(self, db: AsyncMock) -> None:
        bus = AsyncMock()
        bus.emit = AsyncMock()
        eng = WorkflowEngine(db=db, event_bus=bus)
        task = _make_task(TaskStatus.CREATED)
        await eng.transition(task, TaskStatus.ANALYZING)
        bus.emit.assert_called_once()
        call_kwargs = bus.emit.call_args
        assert "task.status_changed" in str(call_kwargs)

    async def test_can_transition(self, engine: WorkflowEngine) -> None:
        assert engine.can_transition(TaskStatus.CREATED, TaskStatus.ANALYZING)
        assert not engine.can_transition(TaskStatus.CREATED, TaskStatus.COMPLETED)

    async def test_allowed_next(self, engine: WorkflowEngine) -> None:
        allowed = engine.allowed_next(TaskStatus.RUNNING)
        assert TaskStatus.QA in allowed
        assert TaskStatus.FAILED in allowed


class TestResume:
    async def test_resume_failed_task(self, engine: WorkflowEngine) -> None:
        task = _make_task(TaskStatus.FAILED)
        result = await engine.resume(task)
        assert result.status == TaskStatus.ANALYZING

    async def test_resume_non_failed_raises(self, engine: WorkflowEngine) -> None:
        task = _make_task(TaskStatus.RUNNING)
        with pytest.raises(WorkflowTransitionError):
            await engine.resume(task)


class TestPause:
    async def test_pause_running_task(self, engine: WorkflowEngine) -> None:
        task = _make_task(TaskStatus.RUNNING)
        result = await engine.pause(task)
        assert result.status == TaskStatus.PAUSED

    async def test_pause_completed_raises(self, engine: WorkflowEngine) -> None:
        task = _make_task(TaskStatus.COMPLETED)
        with pytest.raises(WorkflowTransitionError):
            await engine.pause(task)

    async def test_resume_paused_task(self, engine: WorkflowEngine) -> None:
        task = _make_task(TaskStatus.PAUSED)
        result = await engine.resume_paused(task, target_status=TaskStatus.RUNNING)
        assert result.status == TaskStatus.RUNNING

    async def test_resume_paused_wrong_state_raises(self, engine: WorkflowEngine) -> None:
        task = _make_task(TaskStatus.RUNNING)
        with pytest.raises(WorkflowTransitionError):
            await engine.resume_paused(task)


class TestRollback:
    async def test_rollback_to_previous_state(self, engine: WorkflowEngine, db: AsyncMock) -> None:
        import json
        metadata = json.dumps({"_prev_status": "assigned"})
        task = _make_task(TaskStatus.RUNNING, metadata_json=metadata)
        result = await engine.rollback(task)
        assert result.status == TaskStatus.ASSIGNED

    async def test_rollback_no_metadata_raises(self, engine: WorkflowEngine) -> None:
        task = _make_task(TaskStatus.RUNNING, metadata_json=None)
        with pytest.raises(WorkflowRollbackError):
            await engine.rollback(task)

    async def test_rollback_invalid_state_raises(self, engine: WorkflowEngine) -> None:
        import json
        task = _make_task(TaskStatus.RUNNING, metadata_json=json.dumps({"_prev_status": "garbage"}))
        with pytest.raises(WorkflowRollbackError):
            await engine.rollback(task)


class TestTransitionWithRetry:
    async def test_succeeds_on_first_attempt(self, engine: WorkflowEngine) -> None:
        task = _make_task(TaskStatus.CREATED)
        result = await engine.transition_with_retry(task, TaskStatus.ANALYZING)
        assert result.status == TaskStatus.ANALYZING

    async def test_does_not_retry_workflow_error(self, engine: WorkflowEngine) -> None:
        """WorkflowTransitionError must not be retried."""
        task = _make_task(TaskStatus.CREATED)
        with pytest.raises(WorkflowTransitionError):
            await engine.transition_with_retry(task, TaskStatus.COMPLETED, max_attempts=3)
