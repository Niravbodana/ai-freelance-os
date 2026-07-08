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

LLM_INPUT_TOKENS = Counter(
    "llm_input_tokens_total",
    "Total input tokens consumed by LLM calls",
    ["provider", "model"],
)

LLM_OUTPUT_TOKENS = Counter(
    "llm_output_tokens_total",
    "Total output tokens produced by LLM calls",
    ["provider", "model"],
)

LLM_COST_USD = Counter(
    "llm_cost_usd_total",
    "Estimated LLM spend in USD (based on published pricing)",
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

SCHEDULER_JOBS_SCHEDULED = Counter(
    "scheduler_jobs_scheduled_total",
    "Total jobs submitted to the scheduler",
    ["job_name"],
)

SCHEDULER_JOBS_FIRED = Counter(
    "scheduler_jobs_fired_total",
    "Total scheduler jobs that were dispatched to handlers",
    ["job_name"],
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

# ── Cost estimator ────────────────────────────────────────────────────────────

# Prices in USD per 1 000 tokens (input_price, output_price).
# Values are approximate and should be reviewed when provider pricing changes.
# Last verified: 2026-07 — check provider dashboards for current rates:
#   OpenAI:    https://openai.com/pricing
#   Anthropic: https://www.anthropic.com/pricing
#   DeepSeek:  https://platform.deepseek.com/api-docs/pricing
#   Gemini:    https://ai.google.dev/pricing
_COST_PER_1K: dict[str, dict[str, tuple[float, float]]] = {
    "openai": {
        "gpt-4o": (0.005, 0.015),
        "gpt-4o-mini": (0.00015, 0.0006),
        "gpt-4-turbo": (0.01, 0.03),
        "gpt-3.5-turbo": (0.0005, 0.0015),
    },
    "anthropic": {
        "claude-3-5-sonnet-20241022": (0.003, 0.015),
        "claude-3-haiku-20240307": (0.00025, 0.00125),
        "claude-3-opus-20240229": (0.015, 0.075),
    },
    "deepseek": {
        "deepseek-chat": (0.00014, 0.00028),
    },
    "gemini": {
        "gemini-1.5-pro": (0.00125, 0.005),
        "gemini-1.5-flash": (0.000075, 0.0003),
    },
}


def estimate_cost_usd(provider: str, model: str, input_tokens: int, output_tokens: int) -> float:
    """Return the estimated USD cost for a single LLM call.

    Falls back to 0.0 if the provider/model combination is not in the table.
    """
    pricing = _COST_PER_1K.get(provider, {}).get(model)
    if pricing is None:
        return 0.0
    input_price, output_price = pricing
    return (input_tokens * input_price + output_tokens * output_price) / 1000.0


def record_llm_usage(
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
) -> float:
    """Increment token and cost counters; returns the estimated cost in USD."""
    LLM_INPUT_TOKENS.labels(provider=provider, model=model).inc(input_tokens)
    LLM_OUTPUT_TOKENS.labels(provider=provider, model=model).inc(output_tokens)
    cost = estimate_cost_usd(provider, model, input_tokens, output_tokens)
    if cost > 0:
        LLM_COST_USD.labels(provider=provider, model=model).inc(cost)
    return cost


# ── Helpers ───────────────────────────────────────────────────────────────────


def metrics_output() -> bytes:
    """Render current metrics in Prometheus text format."""
    return generate_latest(REGISTRY)


def get_registry() -> CollectorRegistry:
    return REGISTRY
