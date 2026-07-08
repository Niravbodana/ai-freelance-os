"""Agent registry – maps agent_type strings to agent classes.

Supports:
- Static registrations (built-in agents).
- Dynamic registration at runtime via :meth:`AgentRegistry.register`.
- Loading agent definitions from a JSON configuration file via
  :meth:`AgentRegistry.load_from_config`.

JSON config format::

    {
      "agents": [
        {
          "agent_type": "my_agent",
          "class": "mypackage.mymodule.MyAgent"
        }
      ]
    }
"""
from __future__ import annotations

import importlib
import json
import pathlib
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

    # ── Dynamic registration ──────────────────────────────────────────────────

    @classmethod
    def register(cls, agent_type: str, agent_class: type[BaseAgent]) -> None:
        """Register *agent_class* under *agent_type* globally.

        Overwrites any existing registration for the same type.
        """
        _AGENT_MAP[agent_type] = agent_class
        logger.info("agent_registry.registered", agent_type=agent_type, cls=agent_class.__name__)

    @classmethod
    def unregister(cls, agent_type: str) -> None:
        """Remove the registration for *agent_type* (no-op if not registered)."""
        removed = _AGENT_MAP.pop(agent_type, None)
        if removed is not None:
            logger.info("agent_registry.unregistered", agent_type=agent_type)

    @classmethod
    def load_from_config(cls, config: dict[str, Any] | str | pathlib.Path) -> None:
        """Register agents from a JSON configuration.

        *config* may be:
        - A ``dict`` with an ``"agents"`` key (list of ``{agent_type, class}``).
        - A ``str`` containing JSON text.
        - A :class:`pathlib.Path` to a JSON file.

        Each entry uses the dotted ``"class"`` path to import the class, e.g.
        ``"mypackage.mymodule.MyAgent"``.

        Raises :class:`AgentError` on invalid config or import failures.
        """
        if isinstance(config, (str, pathlib.Path)):
            path = pathlib.Path(config)
            raw = path.read_text(encoding="utf-8") if path.exists() else str(config)
            data: dict[str, Any] = json.loads(raw)
        else:
            data = config

        entries = data.get("agents", [])
        if not isinstance(entries, list):
            raise AgentError("registry", "'agents' must be a list")

        for entry in entries:
            agent_type = entry.get("agent_type")
            class_path = entry.get("class")
            if not agent_type or not class_path:
                raise AgentError("registry", f"Invalid agent entry: {entry!r}")
            try:
                module_path, class_name = class_path.rsplit(".", 1)
                module = importlib.import_module(module_path)
                agent_class = getattr(module, class_name)
            except Exception as exc:
                raise AgentError(
                    "registry", f"Cannot import '{class_path}': {exc}"
                ) from exc
            cls.register(agent_type, agent_class)

    # ── Lookup & dispatch ─────────────────────────────────────────────────────

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
