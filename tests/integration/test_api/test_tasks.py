"""Integration tests for task API endpoints."""
import pytest


@pytest.mark.asyncio
async def test_health_check(client):
    response = await client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_create_task(client):
    response = await client.post(
        "/api/v1/tasks",
        json={"title": "Integration Test Task", "description": "Test description"},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["title"] == "Integration Test Task"
    assert data["status"] == "pending"


@pytest.mark.asyncio
async def test_list_tasks(client):
    # Create a few tasks
    for i in range(3):
        await client.post(
            "/api/v1/tasks",
            json={"title": f"Task {i}", "description": "desc"},
        )

    response = await client.get("/api/v1/tasks")
    assert response.status_code == 200
    data = response.json()
    assert data["total"] >= 3


@pytest.mark.asyncio
async def test_get_task_not_found(client):
    response = await client.get("/api/v1/tasks/nonexistent")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_update_task(client):
    create_resp = await client.post(
        "/api/v1/tasks",
        json={"title": "Original", "description": "desc"},
    )
    task_id = create_resp.json()["id"]

    update_resp = await client.patch(
        f"/api/v1/tasks/{task_id}",
        json={"title": "Updated Title"},
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["title"] == "Updated Title"


@pytest.mark.asyncio
async def test_delete_task(client):
    create_resp = await client.post(
        "/api/v1/tasks",
        json={"title": "To Delete", "description": "desc"},
    )
    task_id = create_resp.json()["id"]

    delete_resp = await client.delete(f"/api/v1/tasks/{task_id}")
    assert delete_resp.status_code == 204

    get_resp = await client.get(f"/api/v1/tasks/{task_id}")
    assert get_resp.status_code == 404
