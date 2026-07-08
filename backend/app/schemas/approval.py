"""Approval Pydantic schemas."""
from datetime import datetime

from pydantic import BaseModel

from backend.app.models.approval import ApprovalStatus


class ApprovalResponse(BaseModel):
    id: str
    task_id: str
    action: str
    status: ApprovalStatus
    reviewer_note: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ApprovalDecision(BaseModel):
    approved: bool
    reviewer_note: str | None = None
