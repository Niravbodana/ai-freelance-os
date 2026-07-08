"""Unit tests for TaskService."""
import pytest

from backend.app.core.exceptions import NotFoundError
from backend.app.models.task import TaskStatus
from backend.app.schemas.task import TaskCreate, TaskUpdate
from backend.app.services.task_service import TaskService


@pytest.mark.asyncio
async def test_create_task(db_session):
    service = TaskService(db_session)
    payload = TaskCreate(title="Test Task", description="Test description")
    task = await service.create(payload)

    assert task.id is not None
    assert task.title == "Test Task"
    assert task.status == TaskStatus.PENDING


@pytest.mark.asyncio
async def test_get_task_not_found(db_session):
    service = TaskService(db_session)
    with pytest.raises(NotFoundError):
        await service.get("nonexistent-id")


@pytest.mark.asyncio
async def test_list_tasks(db_session):
    service = TaskService(db_session)
    for i in range(3):
        await service.create(TaskCreate(title=f"Task {i}", description="desc"))

    tasks, total = await service.list()
    assert total == 3
    assert len(tasks) == 3


@pytest.mark.asyncio
async def test_update_task(db_session):
    service = TaskService(db_session)
    task = await service.create(TaskCreate(title="Original", description="desc"))
    updated = await service.update(task.id, TaskUpdate(title="Updated"))

    assert updated.title == "Updated"


@pytest.mark.asyncio
async def test_delete_task(db_session):
    service = TaskService(db_session)
    task = await service.create(TaskCreate(title="To Delete", description="desc"))
    await service.delete(task.id)

    with pytest.raises(NotFoundError):
        await service.get(task.id)
