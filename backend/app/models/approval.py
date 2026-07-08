"""Approval ORM model – human-in-the-loop decisions."""
from enum import StrEnum

from sqlalchemy import Enum as SAEnum
from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.db.base import Base, TimestampMixin


class ApprovalStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"


class Approval(TimestampMixin, Base):
    __tablename__ = "approvals"

    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    task_id: Mapped[str] = mapped_column(
        String(26), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False
    )
    action: Mapped[str] = mapped_column(String(255), nullable=False)
    context_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[ApprovalStatus] = mapped_column(
        SAEnum(ApprovalStatus), default=ApprovalStatus.PENDING, nullable=False
    )
    reviewer_note: Mapped[str | None] = mapped_column(Text, nullable=True)
