"""Unit tests for ApprovalService."""
import pytest

from backend.app.models.approval import ApprovalStatus
from backend.app.models.task import TaskStatus
from backend.app.schemas.approval import ApprovalDecision
from backend.app.schemas.task import TaskCreate
from backend.app.services.approval_service import ApprovalService
from backend.app.services.task_service import TaskService


@pytest.mark.asyncio
async def test_request_approval(db_session):
    task_service = TaskService(db_session)
    task = await task_service.create(TaskCreate(title="Approval Test", description="desc"))

    approval_service = ApprovalService(db_session)
    approval = await approval_service.request_approval(
        task_id=task.id, action="deploy_to_production"
    )

    assert approval.status == ApprovalStatus.PENDING
    assert approval.action == "deploy_to_production"
    assert approval.task_id == task.id

    # Task should be marked as awaiting approval
    updated_task = await task_service.get(task.id)
    assert updated_task.status == TaskStatus.WAITING_FOR_APPROVAL


@pytest.mark.asyncio
async def test_approve_decision(db_session):
    task_service = TaskService(db_session)
    task = await task_service.create(TaskCreate(title="Approve Test", description="desc"))

    approval_service = ApprovalService(db_session)
    approval = await approval_service.request_approval(task_id=task.id, action="some_action")
    approved = await approval_service.decide(
        approval.id, ApprovalDecision(approved=True, reviewer_note="LGTM")
    )

    assert approved.status == ApprovalStatus.APPROVED
    assert approved.reviewer_note == "LGTM"


@pytest.mark.asyncio
async def test_reject_decision(db_session):
    task_service = TaskService(db_session)
    task = await task_service.create(TaskCreate(title="Reject Test", description="desc"))

    approval_service = ApprovalService(db_session)
    approval = await approval_service.request_approval(task_id=task.id, action="risky_action")
    rejected = await approval_service.decide(
        approval.id, ApprovalDecision(approved=False, reviewer_note="Too risky")
    )

    assert rejected.status == ApprovalStatus.REJECTED
