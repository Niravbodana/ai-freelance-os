"""API v1 router – aggregates all endpoint routers."""
from fastapi import APIRouter

from backend.app.api.v1.endpoints import agents, approvals, health, tasks

api_router = APIRouter()

api_router.include_router(health.router, prefix="/health", tags=["health"])
api_router.include_router(tasks.router, prefix="/tasks", tags=["tasks"])
api_router.include_router(agents.router, prefix="/agents", tags=["agents"])
api_router.include_router(approvals.router, prefix="/approvals", tags=["approvals"])
