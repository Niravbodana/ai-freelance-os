"""Abstract base class for all agents."""
from __future__ import annotations

import abc
import json
from typing import Any, cast

import ulid
from openai.types.chat import ChatCompletionMessageParam
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import settings
from backend.app.core.logging import get_logger
from backend.app.models.agent_run import AgentRun, AgentRunStatus
from backend.app.services.memory_service import MemoryService


class AgentContext:
    """Holds runtime context for a single agent execution."""

    def __init__(
        self,
        task_id: str,
        input_data: dict[str, Any],
        db: AsyncSession,
    ) -> None:
        self.task_id = task_id
        self.input_data = input_data
        self.db = db


class BaseAgent(abc.ABC):
    """
    Abstract base agent.

    Subclasses must implement:
      - agent_type: class-level string identifier
      - _execute(): core logic
    """

    agent_type: str = "base"

    def __init__(self, db: AsyncSession) -> None:
        self._db = db
        self._logger = get_logger(self.__class__.__name__)
        self._memory = MemoryService(db=db, agent_name=self.agent_type)

    @abc.abstractmethod
    async def _execute(self, context: AgentContext) -> dict[str, Any]:
        """Execute the agent's core logic and return output data."""
        ...

    async def run(self, context: AgentContext) -> AgentRun:
        """Run the agent: create run record, execute, persist result."""
        run = AgentRun(
            id=str(ulid.new()),
            task_id=context.task_id,
            agent_type=self.agent_type,
            agent_name=self.__class__.__name__,
            status=AgentRunStatus.RUNNING,
            input_data=json.dumps(context.input_data),
        )
        self._db.add(run)
        await self._db.flush()

        self._logger.info(
            "agent.run.started",
            run_id=run.id,
            task_id=context.task_id,
            agent_type=self.agent_type,
        )

        try:
            output = await self._execute(context)
            run.status = AgentRunStatus.COMPLETED
            run.output_data = json.dumps(output)
            self._logger.info("agent.run.completed", run_id=run.id, agent_type=self.agent_type)
        except Exception as exc:
            run.status = AgentRunStatus.FAILED
            run.error_message = str(exc)
            self._logger.error(
                "agent.run.failed",
                run_id=run.id,
                agent_type=self.agent_type,
                error=str(exc),
            )
            raise

        await self._db.flush()
        return run

    async def _call_llm(self, messages: list[dict[str, str]], **kwargs: Any) -> str:
        """Call the configured LLM. Returns the assistant message content."""
        if not settings.openai_api_key:
            raise RuntimeError("OPENAI_API_KEY is not configured")

        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=settings.openai_api_key)
        response = await client.chat.completions.create(
            model=settings.openai_model,
            messages=cast(list[ChatCompletionMessageParam], messages),
            max_tokens=settings.openai_max_tokens,
            **kwargs,
        )
        return response.choices[0].message.content or ""

    def _load_prompt(self, filename: str) -> str:
        """Load a prompt from the prompts directory."""
        import pathlib

        prompt_path = pathlib.Path(__file__).parent.parent / "prompts" / self.agent_type / filename
        if prompt_path.exists():
            return prompt_path.read_text(encoding="utf-8")
        return ""
