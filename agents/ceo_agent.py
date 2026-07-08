"""CEO Agent – top-level strategy and task decomposition."""
from typing import Any

from agents.base_agent import AgentContext, BaseAgent
from backend.app.services.approval_service import ApprovalService


class CEOAgent(BaseAgent):
    """
    CEO Agent responsibilities:
    - Receive high-level goals.
    - Decompose goals into sub-tasks.
    - Delegate to Operations Manager.
    - Require human approval for strategic decisions.
    """

    agent_type = "ceo"

    async def _execute(self, context: AgentContext) -> dict[str, Any]:
        system_prompt = self._load_prompt("system_prompt.txt") or (
            "You are the CEO of an AI Freelance Operating System. "
            "Your role is to analyze high-level goals, decompose them into "
            "actionable tasks, and delegate to the operations team. "
            "Always flag decisions that require human approval."
        )

        goal = context.input_data.get("goal", "")
        self._logger.info("ceo_agent.analyzing_goal", goal=goal[:100])

        messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": (
                    f"Analyze the following goal and produce a structured task breakdown:\n\n"
                    f"{goal}\n\n"
                    f"Return a JSON object with keys: 'summary', 'sub_tasks' (list), "
                    f"'requires_approval' (bool), 'approval_reason' (str or null)."
                ),
            },
        ]

        raw_response = await self._call_llm(messages)

        # Store in short-term memory
        await self._memory.set_short_term(
            key=f"last_goal_{context.task_id}",
            value={"goal": goal, "response": raw_response},
        )

        # If approval is required, create an approval request
        import json as _json

        try:
            parsed = _json.loads(raw_response)
        except _json.JSONDecodeError:
            parsed = {"summary": raw_response, "sub_tasks": [], "requires_approval": True}

        if parsed.get("requires_approval", True):
            approval_service = ApprovalService(self._db)
            await approval_service.request_approval(
                task_id=context.task_id,
                action="ceo_strategic_decision",
                context={"goal": goal, "breakdown": parsed},
            )

        return {"breakdown": parsed, "raw_llm_response": raw_response}
