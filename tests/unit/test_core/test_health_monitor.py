"""Tests for AgentHealthMonitor."""
from __future__ import annotations

import pytest

from backend.app.core.health_monitor import AgentHealthMonitor


@pytest.fixture()
def monitor() -> AgentHealthMonitor:
    return AgentHealthMonitor()


class TestStartFinish:
    def test_start_returns_token(self, monitor: AgentHealthMonitor) -> None:
        token = monitor.start_task("ceo")
        assert isinstance(token, int)

    def test_running_increments_on_start(self, monitor: AgentHealthMonitor) -> None:
        monitor.start_task("ceo")
        snap = monitor.snapshot("ceo")
        assert snap.running_tasks == 1

    def test_running_decrements_on_finish(self, monitor: AgentHealthMonitor) -> None:
        token = monitor.start_task("ceo")
        monitor.finish_task("ceo", token, success=True)
        snap = monitor.snapshot("ceo")
        assert snap.running_tasks == 0

    def test_success_increments_total_success(self, monitor: AgentHealthMonitor) -> None:
        token = monitor.start_task("worker")
        monitor.finish_task("worker", token, success=True)
        snap = monitor.snapshot("worker")
        assert snap.total_success == 1
        assert snap.total_failure == 0

    def test_failure_increments_total_failure(self, monitor: AgentHealthMonitor) -> None:
        token = monitor.start_task("worker")
        monitor.finish_task("worker", token, success=False)
        snap = monitor.snapshot("worker")
        assert snap.total_failure == 1
        assert snap.total_success == 0

    def test_cost_accumulated(self, monitor: AgentHealthMonitor) -> None:
        token = monitor.start_task("ceo")
        monitor.finish_task("ceo", token, success=True, cost_usd=0.01)
        snap = monitor.snapshot("ceo")
        assert snap.total_cost_usd == pytest.approx(0.01)


class TestSuccessRate:
    def test_full_success_rate(self, monitor: AgentHealthMonitor) -> None:
        for _ in range(5):
            t = monitor.start_task("qa")
            monitor.finish_task("qa", t, success=True)
        assert monitor.snapshot("qa").success_rate == pytest.approx(1.0)

    def test_zero_tasks_rate_is_one(self, monitor: AgentHealthMonitor) -> None:
        # No tasks yet → default to 1.0
        snap = monitor.snapshot("nonexistent")
        assert snap.success_rate == pytest.approx(1.0)

    def test_mixed_success_rate(self, monitor: AgentHealthMonitor) -> None:
        for _ in range(3):
            t = monitor.start_task("ops")
            monitor.finish_task("ops", t, success=True)
        for _ in range(1):
            t = monitor.start_task("ops")
            monitor.finish_task("ops", t, success=False)
        snap = monitor.snapshot("ops")
        assert snap.success_rate == pytest.approx(0.75)


class TestAllSnapshots:
    def test_all_snapshots_returns_all_agents(self, monitor: AgentHealthMonitor) -> None:
        t1 = monitor.start_task("alpha")
        monitor.finish_task("alpha", t1, success=True)
        t2 = monitor.start_task("beta")
        monitor.finish_task("beta", t2, success=True)
        types = {s.agent_type for s in monitor.all_snapshots()}
        assert "alpha" in types
        assert "beta" in types


class TestReset:
    def test_reset_clears_counters(self, monitor: AgentHealthMonitor) -> None:
        t = monitor.start_task("ceo")
        monitor.finish_task("ceo", t, success=True)
        monitor.reset("ceo")
        snap = monitor.snapshot("ceo")
        assert snap.total_started == 0
        assert snap.total_success == 0


class TestToDict:
    def test_to_dict_includes_agent(self, monitor: AgentHealthMonitor) -> None:
        t = monitor.start_task("ceo")
        monitor.finish_task("ceo", t, success=True, cost_usd=0.005)
        d = monitor.to_dict()
        assert "ceo" in d
        assert "success_rate" in d["ceo"]
        assert "total_cost_usd" in d["ceo"]
