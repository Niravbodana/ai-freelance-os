"""Scheduler: delayed jobs, cron jobs, and a retry queue backed by Redis.

Architecture
------------
- **Delayed queue**: Redis sorted set ``scheduler:delayed`` where the score is
  the Unix timestamp (float) at which the job should fire.
- **Cron registry**: Redis hash ``scheduler:cron`` that maps a job id to a JSON
  blob containing the cron expression and callable path.
- **Retry queue**: Dead-lettered jobs that should be re-attempted after a
  configurable back-off are pushed back onto the delayed queue with an
  incremented attempt counter.
- A single background ``asyncio.Task`` polls Redis every second and dispatches
  due jobs.

Cron expression format (5 fields, space-separated)::

    <minute> <hour> <day-of-month> <month> <day-of-week>

Supported field syntax:
- ``*``       – every unit
- ``*/N``     – every N units
- ``N``       – exact value
- ``N,M,...`` – list of values
- ``N-M``     – inclusive range

Usage::
    scheduler = get_scheduler()
    await scheduler.start()

    # Fire once after 30 seconds
    job_id = await scheduler.schedule_once(
        delay_seconds=30,
        name="send_reminder",
        payload={"task_id": "..."},
    )

    # Fire every 5 minutes
    cron_id = await scheduler.schedule_cron(
        cron="*/5 * * * *",
        name="check_deadlines",
        payload={},
    )

    await scheduler.stop()
"""
from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from uuid import uuid4

import redis.asyncio as aioredis

from backend.app.config import settings
from backend.app.core.logging import get_logger
from backend.app.core.metrics import SCHEDULER_JOBS_FIRED, SCHEDULER_JOBS_SCHEDULED

logger = get_logger(__name__)

# ── Cron expression parser ────────────────────────────────────────────────────


def _parse_field(expr: str, lo: int, hi: int) -> frozenset[int]:
    """Parse a single cron field into the set of matching integer values."""
    values: set[int] = set()
    for part in expr.split(","):
        part = part.strip()
        if part == "*":
            values.update(range(lo, hi + 1))
        elif part.startswith("*/"):
            step = int(part[2:])
            values.update(range(lo, hi + 1, step))
        elif "-" in part:
            a, b = part.split("-", 1)
            values.update(range(int(a), int(b) + 1))
        else:
            values.add(int(part))
    return frozenset(values)


@dataclass(frozen=True)
class CronExpression:
    """Parsed representation of a 5-field cron expression.

    Field order: ``<minute> <hour> <day-of-month> <month> <day-of-week>``

    Supported syntax per field:
    - ``*``       – every unit
    - ``*/N``     – every N units (e.g. ``*/15`` = every 15 minutes)
    - ``N``       – exact value
    - ``N,M,...`` – comma-separated list of values
    - ``N-M``     – inclusive range

    Day-of-week uses Python convention (Mon=0 … Sun=6).

    Examples::

        CronExpression.parse("0 * * * *")       # top of every hour
        CronExpression.parse("*/5 9-17 * * 1-5") # every 5 min, business hours, weekdays
        CronExpression.parse("0 0 1 * *")        # midnight on the 1st of each month
    """

    minutes: frozenset[int]
    hours: frozenset[int]
    days: frozenset[int]
    months: frozenset[int]
    weekdays: frozenset[int]

    @classmethod
    def parse(cls, expr: str) -> CronExpression:
        parts = expr.split()
        if len(parts) != 5:
            raise ValueError(f"Cron expression must have 5 fields, got: {expr!r}")
        minute, hour, day, month, weekday = parts
        return cls(
            minutes=_parse_field(minute, 0, 59),
            hours=_parse_field(hour, 0, 23),
            days=_parse_field(day, 1, 31),
            months=_parse_field(month, 1, 12),
            weekdays=_parse_field(weekday, 0, 6),
        )

    def matches(self, dt: datetime) -> bool:
        """Return True if *dt* matches this cron expression (minute granularity)."""
        return (
            dt.minute in self.minutes
            and dt.hour in self.hours
            and dt.day in self.days
            and dt.month in self.months
            and dt.weekday() in self.weekdays  # Python weekday: Mon=0 … Sun=6
        )

    def next_run(self, after: datetime | None = None) -> datetime:
        """Return the next datetime (minute precision) after *after* that matches."""
        from datetime import timedelta

        dt = (after or datetime.now(tz=UTC)).replace(second=0, microsecond=0)
        dt += timedelta(minutes=1)  # start from the *next* minute
        for _ in range(366 * 24 * 60):  # upper bound: 1 year of minutes
            if self.matches(dt):
                return dt
            dt += timedelta(minutes=1)
        raise RuntimeError(f"No next run found for cron {self!r}")  # pragma: no cover


# ── Job model ─────────────────────────────────────────────────────────────────


class ScheduledJobStatus(StrEnum):
    PENDING = "pending"
    FIRED = "fired"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class ScheduledJob:
    name: str
    payload: dict[str, Any]
    job_id: str = field(default_factory=lambda: str(uuid4()))
    status: ScheduledJobStatus = ScheduledJobStatus.PENDING
    attempt: int = 0
    max_attempts: int = 3
    cron: str | None = None  # set for recurring jobs
    created_at: datetime = field(default_factory=lambda: datetime.now(tz=UTC))
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "name": self.name,
            "payload": self.payload,
            "status": str(self.status),
            "attempt": self.attempt,
            "max_attempts": self.max_attempts,
            "cron": self.cron,
            "created_at": self.created_at.isoformat(),
            "error": self.error,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScheduledJob:
        obj = cls(
            name=data["name"],
            payload=data["payload"],
            job_id=data["job_id"],
            status=ScheduledJobStatus(data["status"]),
            attempt=data["attempt"],
            max_attempts=data["max_attempts"],
            cron=data.get("cron"),
            created_at=datetime.fromisoformat(data["created_at"]),
            error=data.get("error"),
        )
        return obj


# ── Job handler type ──────────────────────────────────────────────────────────

JobHandler = Callable[[ScheduledJob], Awaitable[None]]


# ── Scheduler ────────────────────────────────────────────────────────────────

_DELAYED_KEY = "scheduler:delayed"
_CRON_KEY = "scheduler:cron"
_POLL_INTERVAL = 1.0  # seconds


class Scheduler:
    """Redis-backed scheduler for delayed and cron jobs.

    Handlers are registered by job *name* and called when a job fires.
    If no handler is registered the job is logged as unhandled.
    """

    def __init__(self, redis_url: str | None = None) -> None:
        self._redis: aioredis.Redis = aioredis.from_url(
            redis_url or settings.redis_url,
            decode_responses=True,
        )
        self._handlers: dict[str, list[JobHandler]] = {}
        self._task: asyncio.Task[None] | None = None

    # ── Registration ─────────────────────────────────────────────────────────

    def register_handler(self, job_name: str, handler: JobHandler) -> None:
        """Register *handler* to be called when a job with *job_name* fires."""
        self._handlers.setdefault(job_name, []).append(handler)
        logger.debug("scheduler.handler_registered", job_name=job_name)

    # ── Scheduling API ────────────────────────────────────────────────────────

    async def schedule_once(
        self,
        delay_seconds: float,
        name: str,
        payload: dict[str, Any] | None = None,
        max_attempts: int = 3,
    ) -> str:
        """Schedule a one-shot job to fire after *delay_seconds*.

        Returns the job_id.
        """
        job = ScheduledJob(name=name, payload=payload or {}, max_attempts=max_attempts)
        run_at = time.time() + delay_seconds
        await self._redis.zadd(_DELAYED_KEY, {json.dumps(job.to_dict()): run_at})
        SCHEDULER_JOBS_SCHEDULED.labels(job_name=name).inc()
        logger.info(
            "scheduler.job_scheduled",
            job_id=job.job_id,
            name=name,
            delay_seconds=delay_seconds,
        )
        return job.job_id

    async def schedule_cron(
        self,
        cron: str,
        name: str,
        payload: dict[str, Any] | None = None,
        max_attempts: int = 3,
    ) -> str:
        """Schedule a recurring job described by a 5-field *cron* expression.

        Returns the job_id.
        """
        expr = CronExpression.parse(cron)
        job = ScheduledJob(
            name=name, payload=payload or {}, max_attempts=max_attempts, cron=cron
        )
        # Store cron definition in a hash for recovery after restart
        await self._redis.hset(_CRON_KEY, job.job_id, json.dumps(job.to_dict()))
        # Schedule the first run
        next_run = expr.next_run()
        await self._redis.zadd(_DELAYED_KEY, {json.dumps(job.to_dict()): next_run.timestamp()})
        SCHEDULER_JOBS_SCHEDULED.labels(job_name=name).inc()
        logger.info(
            "scheduler.cron_scheduled",
            job_id=job.job_id,
            name=name,
            cron=cron,
            next_run=next_run.isoformat(),
        )
        return job.job_id

    async def cancel(self, job_id: str) -> bool:
        """Cancel all pending instances of a job by job_id.

        Returns True if at least one entry was removed.
        """
        removed = 0
        members = await self._redis.zrange(_DELAYED_KEY, 0, -1)
        for member in members:
            try:
                data = json.loads(member)
            except json.JSONDecodeError:
                continue
            if data.get("job_id") == job_id:
                removed += await self._redis.zrem(_DELAYED_KEY, member)
        await self._redis.hdel(_CRON_KEY, job_id)
        logger.info("scheduler.job_cancelled", job_id=job_id, removed=removed)
        return removed > 0

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Restore cron jobs from Redis and start the polling loop."""
        await self._restore_cron_jobs()
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._poll_loop(), name="scheduler:poll")
            logger.info("scheduler.started")

    async def stop(self) -> None:
        """Cancel the polling task and close the Redis connection."""
        if self._task and not self._task.done():
            self._task.cancel()
            import contextlib

            async with contextlib.suppress(asyncio.CancelledError):
                await self._task
        await self._redis.aclose()
        logger.info("scheduler.stopped")

    # ── Internal ──────────────────────────────────────────────────────────────

    async def _restore_cron_jobs(self) -> None:
        """Re-schedule cron jobs that may be missing from the delayed queue after a restart."""
        cron_entries = await self._redis.hgetall(_CRON_KEY)
        for _job_id, raw in cron_entries.items():
            try:
                data = json.loads(raw)
                job = ScheduledJob.from_dict(data)
                if not job.cron:
                    continue
                expr = CronExpression.parse(job.cron)
                next_run = expr.next_run()
                await self._redis.zadd(
                    _DELAYED_KEY, {json.dumps(job.to_dict()): next_run.timestamp()}
                )
                logger.debug(
                    "scheduler.cron_restored",
                    job_id=job.job_id,
                    next_run=next_run.isoformat(),
                )
            except Exception as exc:
                logger.error("scheduler.restore_error", error=str(exc))

    async def _poll_loop(self) -> None:
        """Continuously poll for due jobs and dispatch them."""
        while True:
            try:
                await self._dispatch_due()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.error("scheduler.poll_error", error=str(exc))
            await asyncio.sleep(_POLL_INTERVAL)

    async def _dispatch_due(self) -> None:
        """Pop and fire all jobs whose run-at timestamp is now or in the past."""
        now = time.time()
        # ZRANGEBYSCORE returns members with score <= now
        due_members = await self._redis.zrangebyscore(_DELAYED_KEY, "-inf", now)
        for member in due_members:
            removed = await self._redis.zrem(_DELAYED_KEY, member)
            if removed == 0:
                continue  # another worker beat us to it
            try:
                job = ScheduledJob.from_dict(json.loads(member))
            except Exception as exc:
                logger.error("scheduler.deserialize_error", error=str(exc))
                continue
            asyncio.create_task(self._fire(job))

    async def _fire(self, job: ScheduledJob) -> None:
        """Execute the job and handle success, failure, and rescheduling."""
        SCHEDULER_JOBS_FIRED.labels(job_name=job.name).inc()
        logger.info("scheduler.job_fired", job_id=job.job_id, name=job.name, attempt=job.attempt)

        handlers = self._handlers.get(job.name, [])
        if not handlers:
            logger.warning("scheduler.no_handler", job_name=job.name, job_id=job.job_id)
        else:
            try:
                await asyncio.gather(*[h(job) for h in handlers])
            except Exception as exc:
                job.error = str(exc)
                job.attempt += 1
                logger.error(
                    "scheduler.job_failed",
                    job_id=job.job_id,
                    name=job.name,
                    attempt=job.attempt,
                    error=str(exc),
                )
                if job.attempt < job.max_attempts:
                    # Retry with exponential back-off: 2^attempt * 5 seconds
                    backoff = (2**job.attempt) * 5.0
                    await self._redis.zadd(
                        _DELAYED_KEY, {json.dumps(job.to_dict()): time.time() + backoff}
                    )
                    logger.info(
                        "scheduler.job_retried",
                        job_id=job.job_id,
                        backoff_seconds=backoff,
                    )
                else:
                    job.status = ScheduledJobStatus.FAILED
                    logger.warning(
                        "scheduler.job_exhausted",
                        job_id=job.job_id,
                        name=job.name,
                        attempts=job.attempt,
                    )
                return

        # Reschedule if cron job
        if job.cron:
            job.attempt = 0
            job.error = None
            expr = CronExpression.parse(job.cron)
            next_run = expr.next_run()
            await self._redis.zadd(_DELAYED_KEY, {json.dumps(job.to_dict()): next_run.timestamp()})
            logger.debug(
                "scheduler.cron_rescheduled",
                job_id=job.job_id,
                next_run=next_run.isoformat(),
            )


# ── Singleton ─────────────────────────────────────────────────────────────────

_scheduler: Scheduler | None = None


def get_scheduler() -> Scheduler:
    """Return the application-wide Scheduler singleton."""
    global _scheduler
    if _scheduler is None:
        _scheduler = Scheduler()
    return _scheduler
