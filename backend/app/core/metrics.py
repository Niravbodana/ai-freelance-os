"""Metrics system: Prometheus-compatible counters, histograms, and gauges.

All metrics are registered once at import time. The FastAPI app exposes
them at the path configured in Settings.metrics_path.
"""
from __future__ import annotations

from prometheus_client import (
    REGISTRY,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)
from prometheus_client import multiprocess as _mp  # noqa: F401 (re-exported)

# ── Counters ──────────────────────────────────────────────────────────────────

TASKS_CREATED = Counter(
    "tasks_created_total",
    "Total number of tasks created",
)

TASKS_COMPLETED = Counter(
    "tasks_completed_total",
    "Total number of tasks completed successfully",
)

TASKS_FAILED = Counter(
    "tasks_failed_total",
    "Total number of tasks that failed",
    ["reason"],
)

APPROVALS_REQUESTED = Counter(
    "approvals_requested_total",
    "Total approval requests issued",
    ["action"],
)

APPROVALS_GRANTED = Counter(
    "approvals_granted_total",
    "Total approvals granted",
    ["action"],
)

APPROVALS_REJECTED = Counter(
    "approvals_rejected_total",
    "Total approvals rejected",
    ["action"],
)

AGENT_RUNS_STARTED = Counter(
    "agent_runs_started_total",
    "Total agent executions started",
    ["agent_type"],
)

AGENT_RUNS_COMPLETED = Counter(
    "agent_runs_completed_total",
    "Total agent executions completed",
    ["agent_type"],
)

AGENT_RUNS_FAILED = Counter(
    "agent_runs_failed_total",
    "Total agent executions failed",
    ["agent_type"],
)

LLM_REQUESTS = Counter(
    "llm_requests_total",
    "Total LLM API requests",
    ["provider", "model"],
)

LLM_ERRORS = Counter(
    "llm_errors_total",
    "Total LLM API errors",
    ["provider", "model"],
)

QUEUE_JOBS_ENQUEUED = Counter(
    "queue_jobs_enqueued_total",
    "Total jobs enqueued",
    ["queue_name"],
)

QUEUE_JOBS_PROCESSED = Counter(
    "queue_jobs_processed_total",
    "Total jobs processed",
    ["queue_name", "status"],
)

RETRY_ATTEMPTS = Counter(
    "retry_attempts_total",
    "Total retry attempts triggered",
    ["operation"],
)

EVENTS_PUBLISHED = Counter(
    "events_published_total",
    "Total events published on the event bus",
    ["event_type"],
)

# ── Histograms ────────────────────────────────────────────────────────────────

AGENT_RUN_DURATION = Histogram(
    "agent_run_duration_seconds",
    "Duration of agent executions in seconds",
    ["agent_type"],
    buckets=(0.1, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0),
)

LLM_LATENCY = Histogram(
    "llm_request_duration_seconds",
    "Duration of LLM API calls in seconds",
    ["provider", "model"],
    buckets=(0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0),
)

APPROVAL_WAIT_TIME = Histogram(
    "approval_wait_duration_seconds",
    "Time in seconds waiting for human approval",
    buckets=(1.0, 5.0, 30.0, 60.0, 300.0, 600.0, 1800.0, 3600.0),
)

HTTP_REQUEST_DURATION = Histogram(
    "http_request_duration_seconds",
    "Duration of HTTP requests in seconds",
    ["method", "path", "status_code"],
    buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0),
)

# ── Gauges ────────────────────────────────────────────────────────────────────

TASKS_IN_FLIGHT = Gauge(
    "tasks_in_flight",
    "Number of tasks currently being processed",
)

APPROVALS_PENDING = Gauge(
    "approvals_pending",
    "Number of approvals currently awaiting a decision",
)

QUEUE_DEPTH = Gauge(
    "queue_depth",
    "Current number of jobs in queue",
    ["queue_name"],
)

PLUGINS_LOADED = Gauge(
    "plugins_loaded",
    "Number of plugins currently loaded",
)

# ── Helpers ───────────────────────────────────────────────────────────────────


def metrics_output() -> bytes:
    """Render current metrics in Prometheus text format."""
    return generate_latest(REGISTRY)


def get_registry() -> CollectorRegistry:
    return REGISTRY
