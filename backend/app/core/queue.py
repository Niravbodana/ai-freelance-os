"""Task queue backed by Redis (FIFO list-based queue).

Each queue is a Redis list. Jobs are serialised as JSON.
Workers pull jobs using BLPOP for blocking consumption.

Usage::
    queue = TaskQueue(name="tasks")
    job_id = await queue.enqueue({"task_id": "...", "agent_type": "ceo"})
    job = await queue.dequeue(timeout=5)
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
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


# ── Queue ─────────────────────────────────────────────────────────────────────


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

    async def close(self) -> None:
        await self._redis.aclose()
