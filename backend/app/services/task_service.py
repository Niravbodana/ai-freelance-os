"""Task business logic service."""
import json
from collections.abc import Sequence

import ulid
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.exceptions import NotFoundError
from backend.app.core.logging import get_logger
from backend.app.models.task import Task, TaskStatus
from backend.app.schemas.task import TaskCreate, TaskUpdate

logger = get_logger(__name__)


class TaskService:
    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def create(self, payload: TaskCreate) -> Task:
        task = Task(
            id=str(ulid.new()),
            title=payload.title,
            description=payload.description,
            priority=payload.priority,
            status=TaskStatus.PENDING,
            metadata_json=json.dumps(payload.metadata) if payload.metadata else None,
        )
        self._db.add(task)
        await self._db.flush()
        await self._db.refresh(task)
        logger.info("task.created", task_id=task.id, title=task.title)
        return task

    async def get(self, task_id: str) -> Task:
        task = await self._db.get(Task, task_id)
        if task is None:
            raise NotFoundError("Task", task_id)
        return task

    async def list(self, offset: int = 0, limit: int = 20) -> tuple[Sequence[Task], int]:
        result = await self._db.execute(
            select(Task).offset(offset).limit(limit).order_by(Task.created_at.desc())
        )
        tasks = result.scalars().all()
        count_result = await self._db.execute(select(func.count()).select_from(Task))
        total = count_result.scalar_one()
        return tasks, total

    async def update(self, task_id: str, payload: TaskUpdate) -> Task:
        task = await self.get(task_id)
        for field, value in payload.model_dump(exclude_unset=True).items():
            setattr(task, field, value)
        await self._db.flush()
        await self._db.refresh(task)
        logger.info("task.updated", task_id=task_id)
        return task

    async def delete(self, task_id: str) -> None:
        task = await self.get(task_id)
        await self._db.delete(task)
        await self._db.flush()
        self._db.expunge(task)
        logger.info("task.deleted", task_id=task_id)
