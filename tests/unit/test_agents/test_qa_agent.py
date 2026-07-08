"""Unit tests for QAAgent."""
from unittest.mock import AsyncMock, patch

import pytest

from agents.base_agent import AgentContext
from agents.qa_agent import QAAgent


@pytest.mark.asyncio
async def test_qa_agent_passes_good_work(db_session):
    agent = QAAgent(db=db_session)
    context = AgentContext(
        task_id="01TASK000000000000000000005",
        input_data={"work_output": "High quality deliverable", "quality_criteria": []},
        db=db_session,
    )

    llm_response = (
        '{"passed": true, "score": 95, "feedback": "Excellent work", '
        '"issues": [], "requires_human_review": false}'
    )

    with patch.object(agent, "_call_llm", new_callable=AsyncMock, return_value=llm_response):
        run = await agent.run(context)

    assert run.task_id == context.task_id


@pytest.mark.asyncio
async def test_qa_agent_requests_review_for_poor_work(db_session):
    agent = QAAgent(db=db_session)
    context = AgentContext(
        task_id="01TASK000000000000000000006",
        input_data={"work_output": "Incomplete output", "quality_criteria": []},
        db=db_session,
    )

    llm_response = (
        '{"passed": false, "score": 30, "feedback": "Needs improvement", '
        '"issues": ["Incomplete"], "requires_human_review": true}'
    )

    with patch.object(agent, "_call_llm", new_callable=AsyncMock, return_value=llm_response):
        run = await agent.run(context)

    assert run.task_id == context.task_id
