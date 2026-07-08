"""Memory service – Redis (short-term) + PostgreSQL (long-term).

Memory is organised into four logical scopes:
- SHORT_TERM   : Ephemeral, Redis-backed, TTL-based (within a task/session).
- LONG_TERM    : Persistent, Postgres-backed, agent-specific facts.
- CLIENT       : Persistent facts about a specific client (shared across agents).
- PROJECT      : Persistent facts about a specific project (shared across agents).
"""
from __future__ import annotations

import json
from enum import StrEnum
from typing import Any

import redis.asyncio as aioredis
import ulid
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import settings
from backend.app.core.logging import get_logger
from backend.app.models.memory import Memory

logger = get_logger(__name__)

_redis_client: aioredis.Redis | None = None


def get_redis() -> aioredis.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis_client


# ── Memory type constants ─────────────────────────────────────────────────────


class MemoryType(StrEnum):
    """Logical scopes for stored memories."""

    GENERAL = "general"
    """Agent-specific general-purpose facts."""

    CLIENT = "client"
    """Facts about a specific client; keyed as 'client:{client_id}:{key}'."""

    PROJECT = "project"
    """Facts about a specific project; keyed as 'project:{project_id}:{key}'."""

    TASK = "task"
    """Facts scoped to a single task execution."""


# ── Service ───────────────────────────────────────────────────────────────────


class MemoryService:
    """
    Two-tier memory:
      - Short-term: Redis (TTL-based, fast).
      - Long-term:  PostgreSQL (persistent, queryable).

    Client and project memories are stored in Postgres with the appropriate
    MemoryType tag so they can be queried across multiple agents.
    """

    SHORT_TERM_TTL = 3600  # 1 hour

    def __init__(self, db: AsyncSession, agent_name: str) -> None:
        self._db = db
        self._agent_name = agent_name
        self._redis = get_redis()

    # ── Short-term (Redis) ────────────────────────────────────────────────────

    async def set_short_term(self, key: str, value: Any, ttl: int | None = None) -> None:
        redis_key = f"memory:{self._agent_name}:{key}"
        await self._redis.set(
            redis_key,
            json.dumps(value),
            ex=ttl or self.SHORT_TERM_TTL,
        )

    async def get_short_term(self, key: str) -> Any | None:
        redis_key = f"memory:{self._agent_name}:{key}"
        raw = await self._redis.get(redis_key)
        return json.loads(raw) if raw else None

    async def delete_short_term(self, key: str) -> None:
        redis_key = f"memory:{self._agent_name}:{key}"
        await self._redis.delete(redis_key)

    # ── Long-term (PostgreSQL) ────────────────────────────────────────────────

    async def set_long_term(
        self,
        key: str,
        value: Any,
        memory_type: str = MemoryType.GENERAL,
        task_id: str | None = None,
    ) -> Memory:
        """Upsert a key/value pair in long-term memory."""
        result = await self._db.execute(
            select(Memory).where(
                Memory.agent_name == self._agent_name,
                Memory.key == key,
            )
        )
        existing = result.scalar_one_or_none()

        serialized = json.dumps(value)
        if existing:
            existing.value = serialized
            existing.memory_type = memory_type
            await self._db.flush()
            return existing

        memory = Memory(
            id=str(ulid.new()),
            agent_name=self._agent_name,
            memory_type=memory_type,
            key=key,
            value=serialized,
            task_id=task_id,
        )
        self._db.add(memory)
        await self._db.flush()
        return memory

    async def get_long_term(self, key: str) -> Any | None:
        result = await self._db.execute(
            select(Memory).where(
                Memory.agent_name == self._agent_name,
                Memory.key == key,
            )
        )
        memory = result.scalar_one_or_none()
        return json.loads(memory.value) if memory else None

    async def list_long_term(self, memory_type: str | None = None) -> list[Memory]:
        query = select(Memory).where(Memory.agent_name == self._agent_name)
        if memory_type:
            query = query.where(Memory.memory_type == memory_type)
        result = await self._db.execute(query)
        return list(result.scalars().all())

    # ── Client memory ─────────────────────────────────────────────────────────

    async def set_client_memory(self, client_id: str, key: str, value: Any) -> Memory:
        """Store a fact scoped to *client_id*."""
        namespaced_key = f"client:{client_id}:{key}"
        return await self.set_long_term(
            key=namespaced_key,
            value=value,
            memory_type=MemoryType.CLIENT,
        )

    async def get_client_memory(self, client_id: str, key: str) -> Any | None:
        namespaced_key = f"client:{client_id}:{key}"
        return await self.get_long_term(namespaced_key)

    async def list_client_memories(self, client_id: str) -> list[Memory]:
        prefix = f"client:{client_id}:"
        result = await self._db.execute(
            select(Memory).where(
                Memory.agent_name == self._agent_name,
                Memory.memory_type == MemoryType.CLIENT,
                Memory.key.startswith(prefix),
            )
        )
        return list(result.scalars().all())

    # ── Project memory ────────────────────────────────────────────────────────

    async def set_project_memory(self, project_id: str, key: str, value: Any) -> Memory:
        """Store a fact scoped to *project_id*."""
        namespaced_key = f"project:{project_id}:{key}"
        return await self.set_long_term(
            key=namespaced_key,
            value=value,
            memory_type=MemoryType.PROJECT,
        )

    async def get_project_memory(self, project_id: str, key: str) -> Any | None:
        namespaced_key = f"project:{project_id}:{key}"
        return await self.get_long_term(namespaced_key)

    async def list_project_memories(self, project_id: str) -> list[Memory]:
        prefix = f"project:{project_id}:"
        result = await self._db.execute(
            select(Memory).where(
                Memory.agent_name == self._agent_name,
                Memory.memory_type == MemoryType.PROJECT,
                Memory.key.startswith(prefix),
            )
        )
        return list(result.scalars().all())
