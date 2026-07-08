"""Task Pydantic schemas."""
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from backend.app.models.task import TaskPriority, TaskStatus


class TaskCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    description: str = Field(..., min_length=1)
    priority: TaskPriority = TaskPriority.MEDIUM
    metadata: dict[str, Any] | None = None


class TaskUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    description: str | None = None
    priority: TaskPriority | None = None
    status: TaskStatus | None = None


class TaskResponse(BaseModel):
    id: str
    title: str
    description: str
    status: TaskStatus
    priority: TaskPriority
    assigned_agent: str | None
    result: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class TaskListResponse(BaseModel):
    items: list[TaskResponse]
    total: int
