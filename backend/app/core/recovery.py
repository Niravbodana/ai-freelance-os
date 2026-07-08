"""Workflow Recovery: resumes unfinished workflows after a server crash.

On startup the recovery service:
1. Scans the database for tasks stuck in transient states
   (ANALYZING, ASSIGNED, RUNNING, QA, WAITING_FOR_APPROVAL).
2. Re-enqueues each recoverable task into the priority queue.
3. Restores pending approvals by emitting APPROVAL_REQUESTED events so
   notification channels can re-notify reviewers.

Usage::
    recovery = get_recovery_service(db=session)
    report = await recovery.recover_all()
    # report.recovered_workflows  → list of task IDs re-queued
    # report.recovered_approvals  → list of approval IDs re-notified
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from sqlalchemy import select

from backend.app.core.logging import get_logger
from backend.app.models.approval import Approval, ApprovalStatus
from backend.app.models.task import Task, TaskStatus

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = get_logger(__name__)

# States that indicate a workflow was interrupted mid-flight
_RECOVERABLE_TASK_STATES: frozenset[TaskStatus] = frozenset(
    {
        TaskStatus.ANALYZING,
        TaskStatus.ASSIGNED,
        TaskStatus.RUNNING,
        TaskStatus.QA,
        TaskStatus.WAITING_FOR_APPROVAL,
    }
)


@dataclass
class RecoveryReport:
    """Summary of what was recovered."""

    recovered_workflows: list[str] = field(default_factory=list)
    recovered_approvals: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    @property
    def total_recovered(self) -> int:
        return len(self.recovered_workflows) + len(self.recovered_approvals)


class WorkflowRecoveryService:
    """Recovers interrupted workflows and pending approvals on startup."""

    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def recover_all(self) -> RecoveryReport:
        """Run full recovery sequence. Returns a :class:`RecoveryReport`."""
        report = RecoveryReport()
        await self._recover_workflows(report)
        await self._recover_approvals(report)
        logger.info(
            "recovery.complete",
            recovered_workflows=len(report.recovered_workflows),
            recovered_approvals=len(report.recovered_approvals),
            errors=len(report.errors),
        )
        return report

    # ── Workflow recovery ─────────────────────────────────────────────────────

    async def _recover_workflows(self, report: RecoveryReport) -> None:
        """Find stuck tasks and re-enqueue them."""
        try:
            result = await self._db.execute(
                select(Task).where(Task.status.in_(list(_RECOVERABLE_TASK_STATES)))
            )
            stuck_tasks: list[Task] = list(result.scalars().all())
        except Exception as exc:
            msg = f"Failed to query recoverable tasks: {exc}"
            logger.error("recovery.query_error", error=msg)
            report.errors.append(msg)
            return

        for task in stuck_tasks:
            try:
                await self._recover_task(task, report)
            except Exception as exc:
                msg = f"Failed to recover task {task.id}: {exc}"
                logger.error("recovery.task_error", task_id=task.id, error=str(exc))
                report.errors.append(msg)

    async def _recover_task(self, task: Task, report: RecoveryReport) -> None:
        """Re-enqueue a single stuck task."""
        from backend.app.core.queue import JobPriority, PriorityTaskQueue

        queue = PriorityTaskQueue(name="recovery")
        priority = JobPriority.HIGH  # recovery tasks jump the queue

        await queue.enqueue(
            payload={
                "task_id": task.id,
                "task_title": task.title,
                "recovered_from_status": str(task.status),
                "recovery": True,
            },
            priority=priority,
        )

        # Emit event so subscribers know the task was recovered
        try:
            from backend.app.core.events import get_event_bus

            await get_event_bus().emit(
                "task.recovered",
                payload={
                    "task_id": task.id,
                    "recovered_from_status": str(task.status),
                },
                source="recovery_service",
            )
        except Exception as exc:
            logger.warning("recovery.event_error", task_id=task.id, error=str(exc))

        report.recovered_workflows.append(task.id)
        logger.info(
            "recovery.task_recovered",
            task_id=task.id,
            from_status=task.status,
        )

    # ── Approval recovery ─────────────────────────────────────────────────────

    async def _recover_approvals(self, report: RecoveryReport) -> None:
        """Re-notify channels about pending approvals."""
        try:
            result = await self._db.execute(
                select(Approval).where(Approval.status == ApprovalStatus.PENDING)
            )
            pending: list[Approval] = list(result.scalars().all())
        except Exception as exc:
            msg = f"Failed to query pending approvals: {exc}"
            logger.error("recovery.approval_query_error", error=msg)
            report.errors.append(msg)
            return

        for approval in pending:
            try:
                await self._recover_approval(approval, report)
            except Exception as exc:
                msg = f"Failed to recover approval {approval.id}: {exc}"
                logger.error("recovery.approval_error", approval_id=approval.id, error=str(exc))
                report.errors.append(msg)

    async def _recover_approval(self, approval: Approval, report: RecoveryReport) -> None:
        """Re-emit the APPROVAL_REQUESTED event for a pending approval."""
        try:
            from backend.app.core.events import EventType, get_event_bus

            await get_event_bus().emit(
                EventType.APPROVAL_REQUESTED,
                payload={
                    "approval_id": approval.id,
                    "task_id": approval.task_id,
                    "action": approval.action,
                    "recovery": True,
                },
                source="recovery_service",
            )
        except Exception as exc:
            logger.warning(
                "recovery.approval_event_error",
                approval_id=approval.id,
                error=str(exc),
            )

        report.recovered_approvals.append(approval.id)
        logger.info("recovery.approval_recovered", approval_id=approval.id)

    # ── Queue recovery ────────────────────────────────────────────────────────

    async def recover_queue_state(self, queue_name: str) -> int:
        """Move dead-letter jobs back to the active queue for retry.

        Returns the number of jobs re-queued.
        """
        from backend.app.core.queue import TaskQueue

        queue = TaskQueue(name=queue_name)
        count = 0
        while True:
            job = await queue.dequeue_dead_letter()
            if job is None:
                break
            job.attempt = 0  # reset attempts
            await queue.enqueue(job.payload, max_attempts=job.max_attempts)
            count += 1
            logger.info(
                "recovery.queue_job_requeued",
                queue=queue_name,
                job_id=job.job_id,
            )
        return count


def get_recovery_service(db: AsyncSession) -> WorkflowRecoveryService:
    """Factory: create a :class:`WorkflowRecoveryService` for the given session."""
    return WorkflowRecoveryService(db=db)
