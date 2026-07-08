"""Worker Agent – executes specific, well-defined tasks."""
from typing import Any

from agents.base_agent import AgentContext, BaseAgent


class WorkerAgent(BaseAgent):
    """
    Worker Agent responsibilities:
    - Execute specific, well-defined tasks assigned by Operations Manager.
    - Return structured results.
    - Flag any blockers or quality concerns.
    """

    agent_type = "worker"

    async def _execute(self, context: AgentContext) -> dict[str, Any]:
        system_prompt = self._load_prompt("system_prompt.txt") or (
            "You are a Worker Agent in an AI Freelance Operating System. "
            "Your role is to execute specific tasks with precision and quality. "
            "Always return structured output. Flag any issues immediately."
        )

        task_description = context.input_data.get("task_description", "")
        task_type = context.input_data.get("task_type", "general")

        self._logger.info(
            "worker_agent.executing",
            task_id=context.task_id,
            task_type=task_type,
        )

        messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": (
                    f"Execute the following task:\n\n{task_description}\n\n"
                    "Return a JSON object with: 'result' (str), 'status' "
                    "('completed'|'blocked'|'partial'), 'issues' (list), "
                    "'confidence_score' (0.0-1.0)."
                ),
            },
        ]

        raw_response = await self._call_llm(messages)

        # Persist to long-term memory
        await self._memory.set_long_term(
            key=f"task_result_{context.task_id}",
            value=raw_response,
            memory_type="task_result",
            task_id=context.task_id,
        )

        return {"result": raw_response, "task_type": task_type}
