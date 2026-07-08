"""Abstract base class for all agents.

Agents communicate through the AgentBus (never directly).
LLM calls go through the ProviderLayer (never directly to a specific model).
"""
from __future__ import annotations

import abc
import json
from typing import Any

import ulid
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.logging import get_logger
from backend.app.core.metrics import (
    AGENT_RUN_DURATION,
    AGENT_RUNS_COMPLETED,
    AGENT_RUNS_FAILED,
    AGENT_RUNS_STARTED,
)
from backend.app.models.agent_run import AgentRun, AgentRunStatus
from backend.app.providers.base import LLMMessage, LLMProvider, LLMRequest
from backend.app.providers.factory import get_default_provider
from backend.app.services.memory_service import MemoryService


class AgentContext:
    """Holds runtime context for a single agent execution."""

    def __init__(
        self,
        task_id: str,
        input_data: dict[str, Any],
        db: AsyncSession,
        provider: LLMProvider | None = None,
    ) -> None:
        self.task_id = task_id
        self.input_data = input_data
        self.db = db
        # Agents may request a specific provider; falls back to default.
        self.provider = provider


class BaseAgent(abc.ABC):
    """
    Abstract base agent.

    All LLM calls are delegated to the configured LLMProvider through
    ``_call_llm()``. Agents never reference a specific AI vendor.

    Subclasses must implement:
      - ``agent_type``: class-level string identifier.
      - ``_execute()``: core agent logic.
    """

    agent_type: str = "base"

    def __init__(self, db: AsyncSession, provider: LLMProvider | None = None) -> None:
        self._db = db
        self._provider: LLMProvider | None = provider
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

        AGENT_RUNS_STARTED.labels(agent_type=self.agent_type).inc()
        self._logger.info(
            "agent.run.started",
            run_id=run.id,
            task_id=context.task_id,
            agent_type=self.agent_type,
        )

        timer = AGENT_RUN_DURATION.labels(agent_type=self.agent_type).time()
        try:
            with timer:
                output = await self._execute(context)
            run.status = AgentRunStatus.COMPLETED
            run.output_data = json.dumps(output)
            AGENT_RUNS_COMPLETED.labels(agent_type=self.agent_type).inc()
            self._logger.info("agent.run.completed", run_id=run.id, agent_type=self.agent_type)
        except Exception as exc:
            run.status = AgentRunStatus.FAILED
            run.error_message = str(exc)
            AGENT_RUNS_FAILED.labels(agent_type=self.agent_type).inc()
            self._logger.error(
                "agent.run.failed",
                run_id=run.id,
                agent_type=self.agent_type,
                error=str(exc),
            )
            raise

        await self._db.flush()

        # Emit run-completed event
        try:
            from backend.app.core.events import EventType, get_event_bus
            await get_event_bus().emit(
                EventType.AGENT_COMPLETED,
                payload={
                    "run_id": run.id,
                    "task_id": context.task_id,
                    "agent_type": self.agent_type,
                },
                source=self.agent_type,
            )
        except Exception:
            pass

        return run

    def _get_provider(self, context: AgentContext | None = None) -> LLMProvider:
        """Resolve the LLMProvider to use: context > instance > default."""
        if context and context.provider:
            return context.provider
        if self._provider:
            return self._provider
        return get_default_provider()

    async def _call_llm(
        self,
        messages: list[dict[str, str]],
        context: AgentContext | None = None,
        **kwargs: Any,
    ) -> str:
        """Call the configured LLM provider. Returns assistant message content."""
        provider = self._get_provider(context)
        _llm_keys = ("model", "max_tokens", "temperature")
        request = LLMRequest(
            messages=[LLMMessage(role=m["role"], content=m["content"]) for m in messages],
            **{k: v for k, v in kwargs.items() if k in _llm_keys},
            extra={k: v for k, v in kwargs.items() if k not in _llm_keys},
        )
        response = await provider.complete(request)

        # Track token usage and estimated cost.
        from backend.app.core.metrics import record_llm_usage

        cost = record_llm_usage(
            provider=response.provider,
            model=response.model,
            input_tokens=response.input_tokens,
            output_tokens=response.output_tokens,
        )
        self._logger.debug(
            "agent.llm_call",
            provider=response.provider,
            model=response.model,
            input_tokens=response.input_tokens,
            output_tokens=response.output_tokens,
            cost_usd=cost,
        )
        return response.content

    def _load_prompt(self, filename: str) -> str:
        """Load a prompt from the prompts directory."""
        import pathlib

        prompt_path = pathlib.Path(__file__).parent.parent / "prompts" / self.agent_type / filename
        if prompt_path.exists():
            return prompt_path.read_text(encoding="utf-8")
        return ""
