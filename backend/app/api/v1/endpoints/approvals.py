"""Approval endpoints – human-in-the-loop."""
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.exceptions import NotFoundError, not_found_exception
from backend.app.dependencies import get_db
from backend.app.schemas.approval import ApprovalDecision, ApprovalResponse
from backend.app.services.approval_service import ApprovalService

router = APIRouter()
DBSession = Annotated[AsyncSession, Depends(get_db)]


@router.get("/pending", response_model=list[ApprovalResponse])
async def list_pending_approvals(
    db: DBSession,
) -> list[ApprovalResponse]:
    service = ApprovalService(db)
    approvals = await service.list_pending()
    return [ApprovalResponse.model_validate(a) for a in approvals]


@router.post("/{approval_id}/decide", response_model=ApprovalResponse)
async def decide_approval(
    approval_id: str,
    decision: ApprovalDecision,
    db: DBSession,
) -> ApprovalResponse:
    service = ApprovalService(db)
    try:
        approval = await service.decide(approval_id, decision)
    except NotFoundError:
        raise not_found_exception("Approval", approval_id) from None
    return ApprovalResponse.model_validate(approval)
