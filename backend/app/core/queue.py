"""Task queue backed by Redis (FIFO list-based queue).

Each queue is a Redis list. Jobs are serialised as JSON.
Workers pull jobs using BLPOP for blocking consumption.

Priority Queue
--------------
:class:`PriorityTaskQueue` uses a Redis sorted set where the score encodes
both priority and insertion order::

    score = priority_level * 1e12 + monotonic_counter

A *lower* score is dequeued first (ZPOPMIN), so ``priority=0`` runs before
``priority=1``. Use the :class:`JobPriority` constants for readability.

Usage::
    queue = TaskQueue(name="tasks")
    job_id = await queue.enqueue({"task_id": "...", "agent_type": "ceo"})
    job = await queue.dequeue(timeout=5)

    pqueue = PriorityTaskQueue(name="priority_tasks")
    await pqueue.enqueue({"task_id": "..."}, priority=JobPriority.HIGH)
    job = await pqueue.dequeue(timeout=5)
"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import IntEnum, StrEnum
from typing import Any
from uuid import uuid4

import redis.asyncio as aioredis

from backend.app.config import settings
from backend.app.core.logging import get_logger
from backend.app.core.metrics import QUEUE_DEPTH, QUEUE_JOBS_ENQUEUED, QUEUE_JOBS_PROCESSED

logger = get_logger(__name__)

# ── Job model ─────────────────────────────────────────────────────────────────


class JobStatus(StrEnum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    DEAD_LETTER = "dead_letter"


class JobPriority(IntEnum):
    """Lower value = higher urgency."""

    CRITICAL = 0
    HIGH = 1
    MEDIUM = 2
    LOW = 3


@dataclass
class Job:
    """Represents a unit of work in the queue."""

    payload: dict[str, Any]
    job_id: str = field(default_factory=lambda: str(uuid4()))
    queue_name: str = "tasks"
    status: JobStatus = JobStatus.PENDING
    attempt: int = 0
    max_attempts: int = field(default_factory=lambda: settings.queue_max_retries)
    created_at: datetime = field(default_factory=lambda: datetime.now(tz=UTC))
    error: str | None = None

    def to_json(self) -> str:
        return json.dumps(
            {
                "job_id": self.job_id,
                "queue_name": self.queue_name,
                "payload": self.payload,
                "status": self.status,
                "attempt": self.attempt,
                "max_attempts": self.max_attempts,
                "created_at": self.created_at.isoformat(),
                "error": self.error,
            }
        )

    @classmethod
    def from_json(cls, raw: str) -> Job:
        data = json.loads(raw)
        obj = cls(
            payload=data["payload"],
            job_id=data["job_id"],
            queue_name=data["queue_name"],
            status=JobStatus(data["status"]),
            attempt=data["attempt"],
            max_attempts=data["max_attempts"],
            created_at=datetime.fromisoformat(data["created_at"]),
            error=data.get("error"),
        )
        return obj


# ── FIFO queue ────────────────────────────────────────────────────────────────


class TaskQueue:
    """Redis-backed FIFO task queue."""

    DEAD_LETTER_SUFFIX = ":dead_letter"

    def __init__(
        self,
        name: str | None = None,
        redis_url: str | None = None,
    ) -> None:
        self._name = name or settings.queue_default_name
        self._redis: aioredis.Redis = aioredis.from_url(
            redis_url or settings.redis_url,
            decode_responses=True,
        )

    @property
    def key(self) -> str:
        return f"queue:{self._name}"

    @property
    def dead_letter_key(self) -> str:
        return f"queue:{self._name}{self.DEAD_LETTER_SUFFIX}"

    async def enqueue(self, payload: dict[str, Any], max_attempts: int | None = None) -> Job:
        """Push a job onto the queue; returns the Job."""
        job = Job(
            payload=payload,
            queue_name=self._name,
            max_attempts=max_attempts or settings.queue_max_retries,
        )
        await self._redis.rpush(self.key, job.to_json())
        depth = await self._redis.llen(self.key)
        QUEUE_JOBS_ENQUEUED.labels(queue_name=self._name).inc()
        QUEUE_DEPTH.labels(queue_name=self._name).set(depth)
        logger.info("queue.enqueued", queue=self._name, job_id=job.job_id)
        return job

    async def dequeue(self, timeout: int = 0) -> Job | None:
        """Pop the oldest job; blocks for *timeout* seconds (0 = non-blocking)."""
        if timeout > 0:
            result = await self._redis.blpop(self.key, timeout=timeout)
            if result is None:
                return None
            _, raw = result
        else:
            raw = await self._redis.lpop(self.key)
            if raw is None:
                return None

        job = Job.from_json(raw)
        depth = await self._redis.llen(self.key)
        QUEUE_DEPTH.labels(queue_name=self._name).set(depth)
        logger.debug("queue.dequeued", queue=self._name, job_id=job.job_id)
        return job

    async def complete(self, job: Job) -> None:
        job.status = JobStatus.COMPLETED
        QUEUE_JOBS_PROCESSED.labels(queue_name=self._name, status="completed").inc()
        logger.info("queue.job_completed", queue=self._name, job_id=job.job_id)

    async def fail(self, job: Job, error: str) -> None:
        """Mark job as failed; move to dead-letter queue if retries are exhausted."""
        job.attempt += 1
        job.error = error

        if job.attempt >= job.max_attempts:
            job.status = JobStatus.DEAD_LETTER
            await self._redis.rpush(self.dead_letter_key, job.to_json())
            QUEUE_JOBS_PROCESSED.labels(queue_name=self._name, status="dead_letter").inc()
            logger.warning(
                "queue.job_dead_lettered",
                queue=self._name,
                job_id=job.job_id,
                attempts=job.attempt,
                error=error,
            )
        else:
            # Re-enqueue for retry
            job.status = JobStatus.PENDING
            await self._redis.rpush(self.key, job.to_json())
            QUEUE_JOBS_PROCESSED.labels(queue_name=self._name, status="retried").inc()
            logger.warning(
                "queue.job_retried",
                queue=self._name,
                job_id=job.job_id,
                attempt=job.attempt,
                error=error,
            )

    async def depth(self) -> int:
        """Return the current number of pending jobs."""
        return await self._redis.llen(self.key)

    async def dequeue_dead_letter(self) -> Job | None:
        """Pop one job from the dead-letter queue (non-blocking)."""
        raw = await self._redis.lpop(self.dead_letter_key)
        if raw is None:
            return None
        return Job.from_json(raw)

    async def dead_letter_depth(self) -> int:
        """Return the number of jobs in the dead-letter queue."""
        return await self._redis.llen(self.dead_letter_key)

    async def close(self) -> None:
        await self._redis.aclose()


# ── Priority queue ────────────────────────────────────────────────────────────

# Scale factor: reserving 12 decimal digits for the monotonic counter keeps
# priorities strictly separated (each priority band can hold up to 10^12 jobs).
# Scale factor: each priority band occupies 10^12 slots so that a CRITICAL job
# with score 0 * 10^12 + <timestamp> is always less than a HIGH job with score
# 1 * 10^12 + <timestamp>, regardless of insertion time.  12 decimal digits
# comfortably exceed the number of jobs any single priority band will ever hold.
_PRIORITY_SCALE = 1_000_000_000_000


class PriorityTaskQueue:
    """Redis sorted-set priority queue.

    Jobs with a lower ``priority`` value (see :class:`JobPriority`) are
    dequeued first.  Within the same priority, jobs are served FIFO using a
    time-based tiebreaker.

    The dead-letter queue is a plain Redis list (``queue:<name>:dead_letter``)
    shared with :class:`TaskQueue` for operational consistency.

    Worker concurrency is controlled via an asyncio.Semaphore: callers obtain
    a slot with ``async with queue.worker_slot()`` before processing each job.
    """

    DEAD_LETTER_SUFFIX = ":dead_letter"

    def __init__(
        self,
        name: str | None = None,
        redis_url: str | None = None,
        max_workers: int = 10,
    ) -> None:
        self._name = (name or settings.queue_default_name) + ":priority"
        self._redis: aioredis.Redis = aioredis.from_url(
            redis_url or settings.redis_url,
            decode_responses=True,
        )
        self._semaphore = asyncio.Semaphore(max_workers)

    @property
    def key(self) -> str:
        return f"queue:{self._name}"

    @property
    def dead_letter_key(self) -> str:
        return f"queue:{self._name}{self.DEAD_LETTER_SUFFIX}"

    def worker_slot(self) -> asyncio.Semaphore:
        """Return the concurrency semaphore for use in ``async with`` blocks.

        Example::
            async with queue.worker_slot():
                job = await queue.dequeue()
                ...
        """
        return self._semaphore

    async def enqueue(
        self,
        payload: dict[str, Any],
        priority: int = JobPriority.MEDIUM,
        max_attempts: int | None = None,
    ) -> Job:
        """Push a job with *priority* (lower = higher urgency)."""
        job = Job(
            payload=payload,
            queue_name=self._name,
            max_attempts=max_attempts or settings.queue_max_retries,
        )
        # score encodes priority band + sub-second insertion timestamp
        score = priority * _PRIORITY_SCALE + time.time()
        await self._redis.zadd(self.key, {job.to_json(): score})
        depth = await self._redis.zcard(self.key)
        QUEUE_JOBS_ENQUEUED.labels(queue_name=self._name).inc()
        QUEUE_DEPTH.labels(queue_name=self._name).set(depth)
        logger.info(
            "priority_queue.enqueued",
            queue=self._name,
            job_id=job.job_id,
            priority=priority,
        )
        return job

    async def dequeue(self, timeout: int = 0) -> Job | None:
        """Pop the highest-priority (lowest score) job.

        Polls up to *timeout* seconds when the queue is empty (0 = non-blocking).
        """
        deadline = time.time() + timeout if timeout > 0 else None
        while True:
            result = await self._redis.zpopmin(self.key, count=1)
            if result:
                raw, _score = result[0]
                job = Job.from_json(raw)
                depth = await self._redis.zcard(self.key)
                QUEUE_DEPTH.labels(queue_name=self._name).set(depth)
                logger.debug(
                    "priority_queue.dequeued", queue=self._name, job_id=job.job_id
                )
                return job

            if deadline is None or time.time() >= deadline:
                return None
            await asyncio.sleep(0.1)

    async def complete(self, job: Job) -> None:
        job.status = JobStatus.COMPLETED
        QUEUE_JOBS_PROCESSED.labels(queue_name=self._name, status="completed").inc()
        logger.info("priority_queue.job_completed", queue=self._name, job_id=job.job_id)

    async def fail(self, job: Job, error: str) -> None:
        """Mark job as failed; dead-letter if retries are exhausted."""
        job.attempt += 1
        job.error = error

        if job.attempt >= job.max_attempts:
            job.status = JobStatus.DEAD_LETTER
            await self._redis.rpush(self.dead_letter_key, job.to_json())
            QUEUE_JOBS_PROCESSED.labels(queue_name=self._name, status="dead_letter").inc()
            logger.warning(
                "priority_queue.job_dead_lettered",
                queue=self._name,
                job_id=job.job_id,
                attempts=job.attempt,
            )
        else:
            job.status = JobStatus.PENDING
            score = JobPriority.MEDIUM * _PRIORITY_SCALE + time.time()
            await self._redis.zadd(self.key, {job.to_json(): score})
            QUEUE_JOBS_PROCESSED.labels(queue_name=self._name, status="retried").inc()
            logger.warning(
                "priority_queue.job_retried",
                queue=self._name,
                job_id=job.job_id,
                attempt=job.attempt,
            )

    async def dequeue_dead_letter(self) -> Job | None:
        """Pop one job from the dead-letter queue (non-blocking)."""
        raw = await self._redis.lpop(self.dead_letter_key)
        if raw is None:
            return None
        return Job.from_json(raw)

    async def dead_letter_depth(self) -> int:
        """Return the number of jobs in the dead-letter queue."""
        return await self._redis.llen(self.dead_letter_key)

    async def depth(self) -> int:
        return await self._redis.zcard(self.key)

    async def close(self) -> None:
        await self._redis.aclose()
