"""Tests for AgentRegistry: dynamic registration and config loading."""
from __future__ import annotations

import pytest

from agents.base_agent import AgentContext, BaseAgent
from agents.registry import _AGENT_MAP, AgentRegistry
from backend.app.core.exceptions import AgentError


class _DummyAgent(BaseAgent):
    agent_type = "dummy"

    async def _execute(self, context: AgentContext) -> dict:
        return {}


@pytest.fixture(autouse=True)
def cleanup_registry():
    """Remove test registrations after each test."""
    yield
    _AGENT_MAP.pop("dummy", None)
    _AGENT_MAP.pop("custom", None)


class TestDynamicRegistration:
    def test_register_adds_to_map(self) -> None:
        AgentRegistry.register("dummy", _DummyAgent)
        assert "dummy" in AgentRegistry.list_available()

    def test_register_overwrites_existing(self) -> None:
        AgentRegistry.register("dummy", _DummyAgent)
        AgentRegistry.register("dummy", _DummyAgent)  # second register
        assert _AGENT_MAP["dummy"] is _DummyAgent

    def test_unregister_removes_from_map(self) -> None:
        AgentRegistry.register("dummy", _DummyAgent)
        AgentRegistry.unregister("dummy")
        assert "dummy" not in AgentRegistry.list_available()

    def test_unregister_unknown_is_noop(self) -> None:
        AgentRegistry.unregister("nonexistent")  # should not raise

    def test_get_agent_after_dynamic_register(self, db_session) -> None:
        AgentRegistry.register("dummy", _DummyAgent)
        registry = AgentRegistry(db=db_session)
        agent = registry.get_agent("dummy")
        assert isinstance(agent, _DummyAgent)

    def test_get_agent_unknown_raises(self, db_session) -> None:
        registry = AgentRegistry(db=db_session)
        with pytest.raises(AgentError):
            registry.get_agent("nonexistent_xyz")


class TestLoadFromConfig:
    def test_load_from_dict(self) -> None:
        config = {
            "agents": [
                {"agent_type": "dummy", "class": "agents.ceo_agent.CEOAgent"},
            ]
        }
        AgentRegistry.load_from_config(config)
        assert "dummy" in AgentRegistry.list_available()

    def test_load_from_json_string(self) -> None:
        import json

        config_json = json.dumps(
            {"agents": [{"agent_type": "dummy", "class": "agents.ceo_agent.CEOAgent"}]}
        )
        AgentRegistry.load_from_config(config_json)
        assert "dummy" in AgentRegistry.list_available()

    def test_load_invalid_entry_raises(self) -> None:
        with pytest.raises(AgentError):
            AgentRegistry.load_from_config({"agents": [{"agent_type": "bad"}]})

    def test_load_bad_class_path_raises(self) -> None:
        with pytest.raises(AgentError):
            AgentRegistry.load_from_config(
                {"agents": [{"agent_type": "bad", "class": "nonexistent.module.Class"}]}
            )
