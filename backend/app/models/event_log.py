"""EventLog ORM model – persisted event history."""
from sqlalchemy import Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.db.base import Base, TimestampMixin


class EventLog(TimestampMixin, Base):
    """Immutable record of every event published on the EventBus."""

    __tablename__ = "event_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    event_type: Mapped[str] = mapped_column(String(100), nullable=False)
    source: Mapped[str] = mapped_column(String(100), nullable=False)
    correlation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False)

    __table_args__ = (
        Index("ix_event_logs_event_type", "event_type"),
        Index("ix_event_logs_correlation_id", "correlation_id"),
    )
