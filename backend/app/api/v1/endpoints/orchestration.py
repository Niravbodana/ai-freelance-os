"""Orchestration API endpoints.

Exposes:
- GET  /orchestration/health          – agent health snapshots
- GET  /orchestration/cost-router     – routing catalogue & classify
- POST /orchestration/cost-router/route – route a prompt to a provider
- GET  /orchestration/registry        – agent registry info
- POST /orchestration/registry/{agent_type}/enable
- POST /orchestration/registry/{agent_type}/disable
- POST /orchestration/registry/{agent_type}/hot-reload
- POST /orchestration/recovery/run    – manual recovery trigger
- GET  /orchestration/rbac/permissions – list permissions for a role
- GET  /orchestration/events/history  – dead-letter event history
"""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.cost_router import RoutingTier, get_cost_router
from backend.app.core.exceptions import AgentError
from backend.app.core.health_monitor import get_health_monitor
from backend.app.core.rbac import get_rbac
from backend.app.dependencies import get_db

router = APIRouter()

DBSession = Annotated[AsyncSession, Depends(get_db)]


# ── Schemas ───────────────────────────────────────────────────────────────────


class RouteRequest(BaseModel):
    prompt: str
    tier: RoutingTier | None = None


# ── Health monitor ────────────────────────────────────────────────────────────


@router.get("/health", summary="Agent health snapshots")
async def get_agent_health() -> dict[str, Any]:
    monitor = get_health_monitor()
    return {"agents": monitor.to_dict()}


@router.get("/health/{agent_type}", summary="Health snapshot for one agent")
async def get_agent_health_by_type(agent_type: str) -> dict[str, Any]:
    monitor = get_health_monitor()
    snapshot = monitor.snapshot(agent_type)
    return {
        "agent_type": snapshot.agent_type,
        "running_tasks": snapshot.running_tasks,
        "total_started": snapshot.total_started,
        "total_success": snapshot.total_success,
        "total_failure": snapshot.total_failure,
        "success_rate": round(snapshot.success_rate, 4),
        "avg_duration_seconds": round(snapshot.avg_duration_seconds, 4),
        "avg_cost_usd": round(snapshot.avg_cost_usd, 6),
        "total_cost_usd": round(snapshot.total_cost_usd, 6),
        "last_seen": snapshot.last_seen.isoformat() if snapshot.last_seen else None,
    }


# ── Cost router ───────────────────────────────────────────────────────────────


@router.get("/cost-router/catalogue", summary="Provider routing catalogue")
async def list_routing_catalogue() -> dict[str, Any]:
    cost_router = get_cost_router()
    return {"catalogue": cost_router.list_catalogue()}


@router.post("/cost-router/route", summary="Route a prompt to best provider")
async def route_prompt(body: RouteRequest) -> dict[str, Any]:
    cost_router = get_cost_router()
    decision = cost_router.route(body.prompt, tier=body.tier)
    return decision.to_dict()


# ── Agent registry ────────────────────────────────────────────────────────────


@router.get("/registry", summary="List all registered agents with metadata")
async def list_agents() -> dict[str, Any]:
    from agents.registry import AgentRegistry

    return {"agents": AgentRegistry.list_info()}


@router.post(
    "/registry/{agent_type}/enable",
    summary="Enable a registered agent",
    status_code=status.HTTP_200_OK,
)
async def enable_agent(agent_type: str) -> dict[str, Any]:
    from agents.registry import AgentRegistry

    try:
        AgentRegistry.enable(agent_type)
    except AgentError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"agent_type": agent_type, "enabled": True}


@router.post(
    "/registry/{agent_type}/disable",
    summary="Disable a registered agent",
    status_code=status.HTTP_200_OK,
)
async def disable_agent(agent_type: str) -> dict[str, Any]:
    from agents.registry import AgentRegistry

    try:
        AgentRegistry.disable(agent_type)
    except AgentError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"agent_type": agent_type, "enabled": False}


@router.post(
    "/registry/{agent_type}/hot-reload",
    summary="Hot-reload an agent class",
    status_code=status.HTTP_200_OK,
)
async def hot_reload_agent(agent_type: str) -> dict[str, Any]:
    from agents.registry import AgentRegistry

    try:
        AgentRegistry.hot_reload(agent_type)
    except AgentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"agent_type": agent_type, "reloaded": True}


# ── Workflow recovery ─────────────────────────────────────────────────────────


@router.post("/recovery/run", summary="Trigger workflow recovery")
async def run_recovery(db: DBSession) -> dict[str, Any]:
    from backend.app.core.recovery import get_recovery_service

    recovery = get_recovery_service(db=db)
    report = await recovery.recover_all()
    return {
        "recovered_workflows": report.recovered_workflows,
        "recovered_approvals": report.recovered_approvals,
        "errors": report.errors,
        "total_recovered": report.total_recovered,
    }


# ── RBAC ──────────────────────────────────────────────────────────────────────


@router.get("/rbac/permissions/{role}", summary="List permissions for a role")
async def get_role_permissions(role: str) -> dict[str, Any]:
    rbac = get_rbac()
    perms = rbac.permissions_for(role)
    return {"role": role, "permissions": sorted(perms)}


# ── Event history ─────────────────────────────────────────────────────────────


@router.get("/events/history", summary="Dead-letter event history")
async def get_event_history() -> dict[str, Any]:
    from backend.app.core.events import get_event_bus

    bus = get_event_bus()
    history = bus.event_history()
    return {
        "count": len(history),
        "events": [
            {
                "event": e.to_dict(),
                "error": str(exc),
            }
            for e, exc in history
        ],
    }
