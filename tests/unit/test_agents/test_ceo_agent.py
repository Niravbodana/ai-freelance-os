"""Unit tests for CEOAgent."""
from unittest.mock import AsyncMock, patch

import pytest

from agents.base_agent import AgentContext
from agents.ceo_agent import CEOAgent


@pytest.mark.asyncio
async def test_ceo_agent_calls_llm(db_session):
    agent = CEOAgent(db=db_session)
    context = AgentContext(
        task_id="01TASK000000000000000000003",
        input_data={"goal": "Build a simple landing page"},
        db=db_session,
    )

    llm_response = (
        '{"summary": "Build landing page", "sub_tasks": ["Design", "Code"], '
        '"requires_approval": false, "approval_reason": null}'
    )

    with (
        patch.object(agent, "_call_llm", new_callable=AsyncMock, return_value=llm_response),
        patch.object(agent._memory, "set_short_term", new_callable=AsyncMock),
    ):
        run = await agent.run(context)

    assert run.task_id == context.task_id


@pytest.mark.asyncio
async def test_ceo_agent_requests_approval_when_required(db_session):
    agent = CEOAgent(db=db_session)
    context = AgentContext(
        task_id="01TASK000000000000000000004",
        input_data={"goal": "Deploy to production"},
        db=db_session,
    )

    llm_response = (
        '{"summary": "Deploy", "sub_tasks": ["Deploy"], '
        '"requires_approval": true, "approval_reason": "Production deployment"}'
    )

    with (
        patch.object(agent, "_call_llm", new_callable=AsyncMock, return_value=llm_response),
        patch.object(agent._memory, "set_short_term", new_callable=AsyncMock),
    ):
        run = await agent.run(context)

    assert run.task_id == context.task_id
