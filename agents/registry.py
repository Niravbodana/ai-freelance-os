"""Agent registry – maps agent_type strings to agent classes."""
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from agents.base_agent import AgentContext, BaseAgent
from agents.ceo_agent import CEOAgent
from agents.operations_manager_agent import OperationsManagerAgent
from agents.qa_agent import QAAgent
from agents.worker_agent import WorkerAgent
from backend.app.core.exceptions import AgentError
from backend.app.core.logging import get_logger
from backend.app.services.task_service import TaskService

logger = get_logger(__name__)

_AGENT_MAP: dict[str, type[BaseAgent]] = {
    "ceo": CEOAgent,
    "operations_manager": OperationsManagerAgent,
    "worker": WorkerAgent,
    "qa": QAAgent,
}


class AgentRegistry:
    """Central registry for creating and dispatching agents."""

    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    def get_agent(self, agent_type: str) -> BaseAgent:
        agent_class = _AGENT_MAP.get(agent_type)
        if agent_class is None:
            raise AgentError("registry", f"Unknown agent type: '{agent_type}'")
        return agent_class(db=self._db)

    async def dispatch(
        self,
        task_id: str,
        agent_type: str,
        input_override: dict[str, Any] | None = None,
    ) -> str:
        """Dispatch an agent for a task. Returns the run ID."""
        task_service = TaskService(self._db)
        task = await task_service.get(task_id)

        agent = self.get_agent(agent_type)
        context = AgentContext(
            task_id=task_id,
            input_data=input_override or {"goal": task.description, "task": task.title},
            db=self._db,
        )

        run = await agent.run(context)
        logger.info("registry.dispatched", run_id=run.id, agent_type=agent_type)
        return run.id

    @staticmethod
    def list_available() -> list[str]:
        return list(_AGENT_MAP.keys())
