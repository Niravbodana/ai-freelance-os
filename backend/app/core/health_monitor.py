"""Agent Health Monitor.

Tracks per-agent metrics:
- Running task count
- Cumulative success / failure counts
- Average execution duration
- Estimated cost per task
- Last-seen timestamp

Uses in-process counters (no Redis dependency) so health data is available
even when Redis is degraded.  Prometheus gauges are updated on each record
call so the /metrics endpoint always reflects current state.

Usage::
    monitor = get_health_monitor()
    token = monitor.start_task("ceo")
    ...
    monitor.finish_task("ceo", token, success=True, duration_seconds=2.3, cost_usd=0.001)

    snapshot = monitor.snapshot("ceo")
    all_snapshots = monitor.all_snapshots()
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from prometheus_client import Counter, Gauge

from backend.app.core.logging import get_logger
from backend.app.core.metrics import (
    AGENT_RUNS_COMPLETED,
    AGENT_RUNS_FAILED,
    AGENT_RUNS_STARTED,
)

logger = get_logger(__name__)

# ── Additional health metrics ─────────────────────────────────────────────────

AGENT_RUNNING_TASKS = Gauge(
    "agent_running_tasks",
    "Number of tasks currently running per agent",
    ["agent_type"],
)

AGENT_SUCCESS_RATE = Gauge(
    "agent_success_rate",
    "Rolling success rate (0.0–1.0) per agent",
    ["agent_type"],
)

AGENT_AVG_DURATION = Gauge(
    "agent_avg_duration_seconds",
    "Rolling average task duration in seconds per agent",
    ["agent_type"],
)

AGENT_COST_PER_TASK = Gauge(
    "agent_cost_per_task_usd",
    "Rolling average cost per task in USD per agent",
    ["agent_type"],
)

AGENT_TOTAL_COST = Counter(
    "agent_total_cost_usd",
    "Cumulative cost in USD per agent",
    ["agent_type"],
)


# ── Data model ────────────────────────────────────────────────────────────────


@dataclass
class AgentHealthSnapshot:
    """Point-in-time snapshot of an agent's health."""

    agent_type: str
    running_tasks: int
    total_started: int
    total_success: int
    total_failure: int
    success_rate: float
    avg_duration_seconds: float
    avg_cost_usd: float
    total_cost_usd: float
    last_seen: datetime | None


# ── Internal per-agent state ──────────────────────────────────────────────────


@dataclass
class _AgentState:
    running: int = 0
    total_started: int = 0
    total_success: int = 0
    total_failure: int = 0
    # Exponential moving-average weight (recent tasks weigh more)
    _ema_duration: float = 0.0
    _ema_cost: float = 0.0
    _total_cost: float = 0.0
    last_seen: datetime | None = None
    # In-flight task tokens: token -> start_time
    _in_flight: dict[int, float] = field(default_factory=dict)
    _token_counter: int = 0

    _EMA_ALPHA: float = 0.2  # class-level constant

    def start(self) -> int:
        """Register a new in-flight task; return opaque token."""
        self._token_counter += 1
        token = self._token_counter
        self._in_flight[token] = time.monotonic()
        self.running += 1
        self.total_started += 1
        self.last_seen = datetime.now(tz=UTC)
        return token

    def finish(
        self,
        token: int,
        success: bool,
        cost_usd: float = 0.0,
    ) -> float:
        """Mark task finished; return actual duration in seconds."""
        start = self._in_flight.pop(token, None)
        duration = (time.monotonic() - start) if start is not None else 0.0
        self.running = max(0, self.running - 1)
        if success:
            self.total_success += 1
        else:
            self.total_failure += 1
        # EMA updates
        alpha = self._EMA_ALPHA
        self._ema_duration = alpha * duration + (1 - alpha) * self._ema_duration
        self._ema_cost = alpha * cost_usd + (1 - alpha) * self._ema_cost
        self._total_cost += cost_usd
        self.last_seen = datetime.now(tz=UTC)
        return duration

    @property
    def success_rate(self) -> float:
        done = self.total_success + self.total_failure
        return self.total_success / done if done > 0 else 1.0


# ── Monitor ───────────────────────────────────────────────────────────────────


class AgentHealthMonitor:
    """Thread-safe in-process health monitor for all agent types."""

    def __init__(self) -> None:
        self._states: dict[str, _AgentState] = defaultdict(_AgentState)
        self._lock = threading.Lock()

    # ── Public API ────────────────────────────────────────────────────────────

    def start_task(self, agent_type: str) -> int:
        """Signal that an agent task has started. Returns a task token."""
        with self._lock:
            state = self._states[agent_type]
            token = state.start()
        AGENT_RUNS_STARTED.labels(agent_type=agent_type).inc()
        AGENT_RUNNING_TASKS.labels(agent_type=agent_type).set(state.running)
        logger.debug("health_monitor.task_started", agent_type=agent_type, token=token)
        return token

    def finish_task(
        self,
        agent_type: str,
        token: int,
        *,
        success: bool,
        cost_usd: float = 0.0,
    ) -> None:
        """Signal that an agent task has finished."""
        with self._lock:
            state = self._states[agent_type]
            duration = state.finish(token, success=success, cost_usd=cost_usd)

        if success:
            AGENT_RUNS_COMPLETED.labels(agent_type=agent_type).inc()
        else:
            AGENT_RUNS_FAILED.labels(agent_type=agent_type).inc()

        AGENT_RUNNING_TASKS.labels(agent_type=agent_type).set(state.running)
        AGENT_SUCCESS_RATE.labels(agent_type=agent_type).set(state.success_rate)
        AGENT_AVG_DURATION.labels(agent_type=agent_type).set(state._ema_duration)
        AGENT_COST_PER_TASK.labels(agent_type=agent_type).set(state._ema_cost)
        if cost_usd > 0:
            AGENT_TOTAL_COST.labels(agent_type=agent_type).inc(cost_usd)

        logger.debug(
            "health_monitor.task_finished",
            agent_type=agent_type,
            token=token,
            success=success,
            duration=round(duration, 4),
            cost_usd=cost_usd,
        )

    def snapshot(self, agent_type: str) -> AgentHealthSnapshot:
        """Return a health snapshot for a single agent type."""
        with self._lock:
            state = self._states[agent_type]
            return AgentHealthSnapshot(
                agent_type=agent_type,
                running_tasks=state.running,
                total_started=state.total_started,
                total_success=state.total_success,
                total_failure=state.total_failure,
                success_rate=state.success_rate,
                avg_duration_seconds=state._ema_duration,
                avg_cost_usd=state._ema_cost,
                total_cost_usd=state._total_cost,
                last_seen=state.last_seen,
            )

    def all_snapshots(self) -> list[AgentHealthSnapshot]:
        """Return health snapshots for all known agent types."""
        with self._lock:
            types = list(self._states.keys())
        return [self.snapshot(t) for t in types]

    def reset(self, agent_type: str) -> None:
        """Reset counters for *agent_type* (useful for tests / hot-reload)."""
        with self._lock:
            self._states[agent_type] = _AgentState()
        logger.info("health_monitor.reset", agent_type=agent_type)

    def to_dict(self) -> dict[str, Any]:
        """Serialise all snapshots to a JSON-compatible dict."""
        return {
            s.agent_type: {
                "running_tasks": s.running_tasks,
                "total_started": s.total_started,
                "total_success": s.total_success,
                "total_failure": s.total_failure,
                "success_rate": round(s.success_rate, 4),
                "avg_duration_seconds": round(s.avg_duration_seconds, 4),
                "avg_cost_usd": round(s.avg_cost_usd, 6),
                "total_cost_usd": round(s.total_cost_usd, 6),
                "last_seen": s.last_seen.isoformat() if s.last_seen else None,
            }
            for s in self.all_snapshots()
        }


# ── Singleton ─────────────────────────────────────────────────────────────────

_monitor: AgentHealthMonitor | None = None


def get_health_monitor() -> AgentHealthMonitor:
    """Return the application-wide AgentHealthMonitor singleton."""
    global _monitor
    if _monitor is None:
        _monitor = AgentHealthMonitor()
    return _monitor
