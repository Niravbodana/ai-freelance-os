"""Memory ORM model – long-term agent memory persisted in Postgres."""
from sqlalchemy import Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.db.base import Base, TimestampMixin


class Memory(TimestampMixin, Base):
    __tablename__ = "memories"

    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    agent_name: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    memory_type: Mapped[str] = mapped_column(String(50), nullable=False)
    key: Mapped[str] = mapped_column(String(255), nullable=False)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    task_id: Mapped[str | None] = mapped_column(String(26), nullable=True)

    __table_args__ = (Index("ix_memories_agent_key", "agent_name", "key"),)
