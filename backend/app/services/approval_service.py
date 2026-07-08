"""Human-in-the-loop approval service."""
import json
from collections.abc import Sequence
from typing import Any

import ulid
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.exceptions import NotFoundError
from backend.app.core.logging import get_logger
from backend.app.models.approval import Approval, ApprovalStatus
from backend.app.models.task import Task, TaskStatus
from backend.app.schemas.approval import ApprovalDecision

logger = get_logger(__name__)


class ApprovalService:
    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def request_approval(
        self, task_id: str, action: str, context: dict[str, Any] | None = None
    ) -> Approval:
        # Mark task as awaiting approval
        task = await self._db.get(Task, task_id)
        if task:
            task.status = TaskStatus.AWAITING_APPROVAL

        approval = Approval(
            id=str(ulid.new()),
            task_id=task_id,
            action=action,
            context_json=json.dumps(context) if context else None,
            status=ApprovalStatus.PENDING,
        )
        self._db.add(approval)
        await self._db.flush()
        logger.info("approval.requested", approval_id=approval.id, action=action)
        return approval

    async def decide(self, approval_id: str, decision: ApprovalDecision) -> Approval:
        approval = await self._db.get(Approval, approval_id)
        if approval is None:
            raise NotFoundError("Approval", approval_id)

        approval.status = ApprovalStatus.APPROVED if decision.approved else ApprovalStatus.REJECTED
        approval.reviewer_note = decision.reviewer_note
        await self._db.flush()
        logger.info(
            "approval.decided",
            approval_id=approval_id,
            approved=decision.approved,
        )
        return approval

    async def list_pending(self) -> Sequence[Approval]:
        result = await self._db.execute(
            select(Approval).where(Approval.status == ApprovalStatus.PENDING)
        )
        return result.scalars().all()
