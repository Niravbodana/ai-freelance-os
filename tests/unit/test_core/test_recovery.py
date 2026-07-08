"""Tests for WorkflowRecoveryService."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.core.recovery import RecoveryReport, WorkflowRecoveryService
from backend.app.models.approval import Approval, ApprovalStatus
from backend.app.models.task import Task, TaskPriority, TaskStatus


def _make_task(status: TaskStatus) -> MagicMock:
    task = MagicMock(spec=Task)
    task.id = "task-001"
    task.title = "Test task"
    task.status = status
    task.priority = TaskPriority.MEDIUM
    return task


def _make_approval() -> MagicMock:
    approval = MagicMock(spec=Approval)
    approval.id = "appr-001"
    approval.task_id = "task-001"
    approval.action = "execute"
    approval.status = ApprovalStatus.PENDING
    return approval


@pytest.fixture()
def db() -> AsyncMock:
    db = AsyncMock()
    db.execute = AsyncMock()
    db.flush = AsyncMock()
    return db


class TestRecoveryReport:
    def test_total_recovered(self) -> None:
        report = RecoveryReport(
            recovered_workflows=["t1", "t2"],
            recovered_approvals=["a1"],
        )
        assert report.total_recovered == 3

    def test_empty_report(self) -> None:
        report = RecoveryReport()
        assert report.total_recovered == 0


class TestWorkflowRecovery:
    async def test_recover_all_empty_db(self, db: AsyncMock) -> None:
        """When there are no stuck tasks, recovery runs cleanly."""
        scalars_mock = MagicMock()
        scalars_mock.all.return_value = []
        result_mock = MagicMock()
        result_mock.scalars.return_value = scalars_mock
        db.execute.return_value = result_mock

        service = WorkflowRecoveryService(db=db)
        report = await service.recover_all()
        assert report.total_recovered == 0
        assert report.errors == []

    async def test_recover_task_enqueues(self, db: AsyncMock) -> None:
        """Stuck tasks should be enqueued for recovery."""
        task = _make_task(TaskStatus.RUNNING)
        scalars_mock = MagicMock()
        scalars_mock.all.side_effect = [[task], []]  # tasks, then approvals
        result_mock = MagicMock()
        result_mock.scalars.return_value = scalars_mock
        db.execute.return_value = result_mock

        service = WorkflowRecoveryService(db=db)

        with patch(
            "backend.app.core.queue.PriorityTaskQueue.enqueue",
            new_callable=AsyncMock,
        ), patch(
            "backend.app.core.events.EventBus.emit",
            new_callable=AsyncMock,
        ):
            report = await service.recover_all()

        assert task.id in report.recovered_workflows

    async def test_recover_approval_emits_event(self, db: AsyncMock) -> None:
        """Pending approvals should re-emit APPROVAL_REQUESTED events."""
        approval = _make_approval()
        scalars_mock = MagicMock()
        scalars_mock.all.side_effect = [[], [approval]]
        result_mock = MagicMock()
        result_mock.scalars.return_value = scalars_mock
        db.execute.return_value = result_mock

        service = WorkflowRecoveryService(db=db)

        with patch(
            "backend.app.core.events.EventBus.emit",
            new_callable=AsyncMock,
        ) as mock_emit:
            report = await service.recover_all()

        assert approval.id in report.recovered_approvals
        mock_emit.assert_called_once()

    async def test_db_error_adds_to_errors(self, db: AsyncMock) -> None:
        """Database errors should be captured in report.errors."""
        db.execute.side_effect = RuntimeError("db error")
        service = WorkflowRecoveryService(db=db)
        report = await service.recover_all()
        assert len(report.errors) > 0
