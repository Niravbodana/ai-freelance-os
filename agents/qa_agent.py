"""QA Agent – validates and reviews worker output."""
from typing import Any

from agents.base_agent import AgentContext, BaseAgent
from backend.app.services.approval_service import ApprovalService


class QAAgent(BaseAgent):
    """
    QA Agent responsibilities:
    - Review and validate worker output.
    - Ensure quality standards are met.
    - Request human approval for edge cases.
    - Return pass/fail with detailed feedback.
    """

    agent_type = "qa"

    async def _execute(self, context: AgentContext) -> dict[str, Any]:
        system_prompt = self._load_prompt("system_prompt.txt") or (
            "You are the QA Agent in an AI Freelance Operating System. "
            "Your role is to rigorously review work output for quality, accuracy, "
            "and completeness. Be critical but constructive. "
            "If quality is below acceptable standards, flag for human review."
        )

        work_output = context.input_data.get("work_output", "")
        quality_criteria = context.input_data.get("quality_criteria", [])

        self._logger.info("qa_agent.reviewing", task_id=context.task_id)

        messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": (
                    f"Review the following work output:\n\n{work_output}\n\n"
                    f"Quality criteria: {quality_criteria}\n\n"
                    "Return a JSON object with: 'passed' (bool), 'score' (0-100), "
                    "'feedback' (str), 'issues' (list), 'requires_human_review' (bool)."
                ),
            },
        ]

        raw_response = await self._call_llm(messages)

        import json as _json

        try:
            qa_result = _json.loads(raw_response)
        except _json.JSONDecodeError:
            qa_result = {"passed": False, "requires_human_review": True}

        if qa_result.get("requires_human_review", False):
            approval_service = ApprovalService(self._db)
            await approval_service.request_approval(
                task_id=context.task_id,
                action="qa_human_review",
                context={"work_output": work_output, "qa_result": qa_result},
            )

        return {"qa_result": qa_result, "raw_llm_response": raw_response}
