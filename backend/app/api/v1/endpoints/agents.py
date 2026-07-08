"""Agent dispatch and run history endpoints."""
from typing import Annotated

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.logging import get_logger
from backend.app.dependencies import get_db
from backend.app.schemas.agent import AgentDispatchRequest, AgentDispatchResponse

router = APIRouter()
logger = get_logger(__name__)
DBSession = Annotated[AsyncSession, Depends(get_db)]


@router.post("/dispatch", status_code=status.HTTP_202_ACCEPTED)
async def dispatch_agent(
    payload: AgentDispatchRequest,
    db: DBSession,
) -> AgentDispatchResponse:
    """
    Dispatch an agent to handle a task.
    The actual agent execution is handled asynchronously.
    """
    from agents.registry import AgentRegistry
    from backend.app.models.agent_run import AgentRunStatus

    registry = AgentRegistry(db=db)
    run_id = await registry.dispatch(task_id=payload.task_id, agent_type=payload.agent_type)
    logger.info("agent.dispatched", task_id=payload.task_id, agent_type=payload.agent_type)
    return AgentDispatchResponse(
        run_id=run_id,
        task_id=payload.task_id,
        agent_type=payload.agent_type,
        status=AgentRunStatus.STARTED,
    )
