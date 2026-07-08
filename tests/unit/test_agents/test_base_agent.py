"""Unit tests for BaseAgent."""
import json
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from agents.base_agent import AgentContext, BaseAgent
from backend.app.models.agent_run import AgentRunStatus


class ConcreteAgent(BaseAgent):
    agent_type = "test_agent"

    async def _execute(self, context: AgentContext) -> dict[str, Any]:
        del context
        return {"result": "test_output"}


@pytest.mark.asyncio
async def test_agent_run_creates_run_record(db_session):
    agent = ConcreteAgent(db=db_session)
    context = AgentContext(
        task_id="01TASK000000000000000000001",
        input_data={"key": "value"},
        db=db_session,
    )

    # Patch memory to avoid Redis dependency
    with patch.object(agent._memory, "set_short_term", new_callable=AsyncMock):
        run = await agent.run(context)

    assert run.status == AgentRunStatus.COMPLETED
    assert run.task_id == context.task_id
    assert run.agent_type == "test_agent"
    output = json.loads(run.output_data)
    assert output["result"] == "test_output"


@pytest.mark.asyncio
async def test_agent_run_handles_failure(db_session):
    class FailingAgent(BaseAgent):
        agent_type = "failing_agent"

        async def _execute(self, context: AgentContext) -> dict[str, Any]:
            del context
            raise ValueError("deliberate failure")

    agent = FailingAgent(db=db_session)
    context = AgentContext(
        task_id="01TASK000000000000000000002",
        input_data={},
        db=db_session,
    )

    with pytest.raises(ValueError, match="deliberate failure"):
        await agent.run(context)
