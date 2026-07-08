"""Operations Manager Agent – task coordination and worker assignment."""
from typing import Any

from agents.base_agent import AgentContext, BaseAgent


class OperationsManagerAgent(BaseAgent):
    """
    Operations Manager Agent responsibilities:
    - Receive decomposed tasks from CEO.
    - Assign tasks to appropriate worker agents.
    - Monitor progress and handle escalations.
    - Report status back to CEO.
    """

    agent_type = "operations_manager"

    async def _execute(self, context: AgentContext) -> dict[str, Any]:
        system_prompt = self._load_prompt("system_prompt.txt") or (
            "You are the Operations Manager of an AI Freelance Operating System. "
            "Your role is to coordinate worker agents, assign tasks, monitor progress, "
            "and ensure quality deliverables. You must always verify task completion "
            "before marking them done."
        )

        task_breakdown = context.input_data.get("breakdown", {})
        sub_tasks = task_breakdown.get("sub_tasks", [])

        self._logger.info(
            "ops_manager.coordinating",
            task_id=context.task_id,
            sub_task_count=len(sub_tasks),
        )

        messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": (
                    f"Coordinate the following sub-tasks and assign them to workers:\n\n"
                    f"{sub_tasks}\n\n"
                    "Return a JSON object with: 'assignments' (list of "
                    "{{sub_task, worker_type, priority}}), 'coordination_plan' (str)."
                ),
            },
        ]

        raw_response = await self._call_llm(messages)

        await self._memory.set_short_term(key=f"coordination_{context.task_id}", value=raw_response)

        return {"coordination_plan": raw_response, "sub_tasks_count": len(sub_tasks)}
