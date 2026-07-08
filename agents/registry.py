"""Agent registry – maps agent_type strings to agent classes.

Supports:
- Static registrations (built-in agents).
- Dynamic registration at runtime via :meth:`AgentRegistry.register`.
- Agent capabilities and version metadata.
- Enable / disable agents at runtime.
- Hot reload: re-import and swap an agent class without restarting.
- Health status tracking per agent type.
- Loading agent definitions from a JSON configuration file via
  :meth:`AgentRegistry.load_from_config`.

JSON config format::

    {
      "agents": [
        {
          "agent_type": "my_agent",
          "class": "mypackage.mymodule.MyAgent",
          "version": "1.0.0",
          "capabilities": ["text_generation", "summarisation"]
        }
      ]
    }
"""
from __future__ import annotations

import importlib
import json
import pathlib
from dataclasses import dataclass, field
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


# ── Agent metadata ────────────────────────────────────────────────────────────


@dataclass
class AgentInfo:
    """Metadata for a registered agent."""

    agent_type: str
    agent_class: type[BaseAgent]
    version: str = "1.0.0"
    capabilities: list[str] = field(default_factory=list)
    enabled: bool = True
    # dotted module path for hot-reload
    class_path: str = ""


_AGENT_REGISTRY: dict[str, AgentInfo] = {
    "ceo": AgentInfo(
        agent_type="ceo",
        agent_class=CEOAgent,
        version="1.0.0",
        capabilities=["task_analysis", "delegation"],
        class_path="agents.ceo_agent.CEOAgent",
    ),
    "operations_manager": AgentInfo(
        agent_type="operations_manager",
        agent_class=OperationsManagerAgent,
        version="1.0.0",
        capabilities=["task_coordination", "reporting"],
        class_path="agents.operations_manager_agent.OperationsManagerAgent",
    ),
    "worker": AgentInfo(
        agent_type="worker",
        agent_class=WorkerAgent,
        version="1.0.0",
        capabilities=["task_execution"],
        class_path="agents.worker_agent.WorkerAgent",
    ),
    "qa": AgentInfo(
        agent_type="qa",
        agent_class=QAAgent,
        version="1.0.0",
        capabilities=["quality_assurance", "review"],
        class_path="agents.qa_agent.QAAgent",
    ),
}

# Backwards-compat: keep a simple map for existing callers
_AGENT_MAP: dict[str, type[BaseAgent]] = {k: v.agent_class for k, v in _AGENT_REGISTRY.items()}


class AgentRegistry:
    """Central registry for creating and dispatching agents."""

    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    # ── Dynamic registration ──────────────────────────────────────────────────

    @classmethod
    def register(
        cls,
        agent_type: str,
        agent_class: type[BaseAgent],
        *,
        version: str = "1.0.0",
        capabilities: list[str] | None = None,
        class_path: str = "",
    ) -> None:
        """Register *agent_class* under *agent_type* globally.

        Overwrites any existing registration for the same type.
        """
        info = AgentInfo(
            agent_type=agent_type,
            agent_class=agent_class,
            version=version,
            capabilities=capabilities or [],
            enabled=True,
            class_path=class_path,
        )
        _AGENT_REGISTRY[agent_type] = info
        _AGENT_MAP[agent_type] = agent_class
        logger.info(
            "agent_registry.registered",
            agent_type=agent_type,
            cls=agent_class.__name__,
            version=version,
        )

    @classmethod
    def unregister(cls, agent_type: str) -> None:
        """Remove the registration for *agent_type* (no-op if not registered)."""
        removed = _AGENT_REGISTRY.pop(agent_type, None)
        _AGENT_MAP.pop(agent_type, None)
        if removed is not None:
            logger.info("agent_registry.unregistered", agent_type=agent_type)

    @classmethod
    def enable(cls, agent_type: str) -> None:
        """Enable an agent type for dispatch."""
        info = _AGENT_REGISTRY.get(agent_type)
        if info is None:
            raise AgentError("registry", f"Unknown agent type: '{agent_type}'")
        info.enabled = True
        logger.info("agent_registry.enabled", agent_type=agent_type)

    @classmethod
    def disable(cls, agent_type: str) -> None:
        """Disable an agent type; dispatching will raise AgentError."""
        info = _AGENT_REGISTRY.get(agent_type)
        if info is None:
            raise AgentError("registry", f"Unknown agent type: '{agent_type}'")
        info.enabled = False
        logger.info("agent_registry.disabled", agent_type=agent_type)

    @classmethod
    def hot_reload(cls, agent_type: str) -> None:
        """Re-import the agent module and swap the class in place.

        Requires the agent to have been registered with a ``class_path``.
        """
        info = _AGENT_REGISTRY.get(agent_type)
        if info is None:
            raise AgentError("registry", f"Unknown agent type: '{agent_type}'")
        if not info.class_path:
            raise AgentError(
                "registry",
                f"No class_path recorded for '{agent_type}'; cannot hot-reload",
            )
        try:
            module_path, class_name = info.class_path.rsplit(".", 1)
            module = importlib.import_module(module_path)
            importlib.reload(module)
            new_class: type[BaseAgent] = getattr(module, class_name)
            info.agent_class = new_class
            _AGENT_MAP[agent_type] = new_class
            logger.info("agent_registry.hot_reloaded", agent_type=agent_type)
        except Exception as exc:
            raise AgentError(
                "registry", f"Hot-reload failed for '{agent_type}': {exc}"
            ) from exc

    @classmethod
    def get_info(cls, agent_type: str) -> AgentInfo:
        """Return :class:`AgentInfo` for *agent_type*."""
        info = _AGENT_REGISTRY.get(agent_type)
        if info is None:
            raise AgentError("registry", f"Unknown agent type: '{agent_type}'")
        return info

    @classmethod
    def load_from_config(cls, config: dict[str, Any] | str | pathlib.Path) -> None:
        """Register agents from a JSON configuration.

        *config* may be:
        - A ``dict`` with an ``"agents"`` key (list of ``{agent_type, class}``).
        - A ``str`` containing JSON text.
        - A :class:`pathlib.Path` to a JSON file.

        Each entry uses the dotted ``"class"`` path to import the class, e.g.
        ``"mypackage.mymodule.MyAgent"``.

        Optional fields per entry: ``version``, ``capabilities`` (list of str).

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
            cls.register(
                agent_type,
                agent_class,
                version=entry.get("version", "1.0.0"),
                capabilities=entry.get("capabilities", []),
                class_path=class_path,
            )

    # ── Lookup & dispatch ─────────────────────────────────────────────────────

    def get_agent(self, agent_type: str) -> BaseAgent:
        info = _AGENT_REGISTRY.get(agent_type)
        if info is None:
            raise AgentError("registry", f"Unknown agent type: '{agent_type}'")
        if not info.enabled:
            raise AgentError("registry", f"Agent '{agent_type}' is currently disabled")
        return info.agent_class(db=self._db)

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
        return [k for k, v in _AGENT_REGISTRY.items() if v.enabled]

    @staticmethod
    def list_all() -> list[str]:
        """List all registered agents including disabled ones."""
        return list(_AGENT_REGISTRY.keys())

    @staticmethod
    def list_info() -> list[dict[str, Any]]:
        """Return metadata for all registered agents."""
        return [
            {
                "agent_type": info.agent_type,
                "version": info.version,
                "capabilities": info.capabilities,
                "enabled": info.enabled,
                "class": info.agent_class.__name__,
            }
            for info in _AGENT_REGISTRY.values()
        ]
