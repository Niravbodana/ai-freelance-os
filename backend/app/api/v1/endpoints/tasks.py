"""Task CRUD endpoints."""
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.exceptions import NotFoundError, not_found_exception
from backend.app.dependencies import get_db
from backend.app.schemas.task import TaskCreate, TaskListResponse, TaskResponse, TaskUpdate
from backend.app.services.task_service import TaskService

router = APIRouter()
DBSession = Annotated[AsyncSession, Depends(get_db)]


@router.post("", response_model=TaskResponse, status_code=status.HTTP_201_CREATED)
async def create_task(
    payload: TaskCreate,
    db: DBSession,
) -> TaskResponse:
    service = TaskService(db)
    task = await service.create(payload)
    return TaskResponse.model_validate(task)


@router.get("", response_model=TaskListResponse)
async def list_tasks(
    db: DBSession,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
) -> TaskListResponse:
    service = TaskService(db)
    tasks, total = await service.list(offset=offset, limit=limit)
    return TaskListResponse(
        items=[TaskResponse.model_validate(t) for t in tasks],
        total=total,
    )


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(task_id: str, db: DBSession) -> TaskResponse:
    service = TaskService(db)
    try:
        task = await service.get(task_id)
    except NotFoundError:
        raise not_found_exception("Task", task_id) from None
    return TaskResponse.model_validate(task)


@router.patch("/{task_id}", response_model=TaskResponse)
async def update_task(
    task_id: str,
    payload: TaskUpdate,
    db: DBSession,
) -> TaskResponse:
    service = TaskService(db)
    try:
        task = await service.update(task_id, payload)
    except NotFoundError:
        raise not_found_exception("Task", task_id) from None
    return TaskResponse.model_validate(task)


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_task(task_id: str, db: DBSession) -> None:
    service = TaskService(db)
    try:
        await service.delete(task_id)
    except NotFoundError:
        raise not_found_exception("Task", task_id) from None
