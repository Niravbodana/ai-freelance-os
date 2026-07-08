"""Retry infrastructure built on tenacity.

Provides pre-configured retry decorators and a reusable retry factory
so every service and provider uses consistent retry semantics.
"""
from __future__ import annotations

import asyncio
import functools
from collections.abc import Awaitable, Callable
from typing import Any

from tenacity import (
    AsyncRetrying,
    RetryCallState,
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
    wait_random_exponential,
)
from tenacity.stop import StopBaseT
from tenacity.wait import WaitBaseT

from backend.app.config import settings
from backend.app.core.logging import get_logger
from backend.app.core.metrics import RETRY_ATTEMPTS

logger = get_logger(__name__)


# ── Logging callback ──────────────────────────────────────────────────────────


def _log_retry(retry_state: RetryCallState) -> None:
    """Emit a structured log entry and increment the metric on each retry."""
    exc = retry_state.outcome.exception() if retry_state.outcome else None
    operation = retry_state.fn.__qualname__ if retry_state.fn else "unknown"
    RETRY_ATTEMPTS.labels(operation=operation).inc()
    logger.warning(
        "retry.attempt",
        operation=operation,
        attempt=retry_state.attempt_number,
        error=str(exc) if exc else None,
        wait_seconds=retry_state.next_action.sleep if retry_state.next_action else None,
    )


# ── Pre-built decorators ──────────────────────────────────────────────────────

#: Standard retry for transient I/O / network errors.
retry_transient = retry(
    stop=stop_after_attempt(settings.retry_max_attempts),
    wait=wait_exponential(
        multiplier=1,
        min=settings.retry_wait_min_seconds,
        max=settings.retry_wait_max_seconds,
    ),
    retry=retry_if_exception_type((OSError, TimeoutError, asyncio.TimeoutError)),
    before_sleep=_log_retry,
    reraise=True,
)

#: Aggressive retry for external HTTP/LLM calls with jitter.
retry_llm = retry(
    stop=stop_after_attempt(settings.retry_max_attempts),
    wait=wait_random_exponential(
        multiplier=1,
        min=settings.retry_wait_min_seconds,
        max=settings.retry_wait_max_seconds,
    ),
    retry=retry_if_exception_type(Exception),
    before_sleep=_log_retry,
    reraise=True,
)


# ── Factory ───────────────────────────────────────────────────────────────────


class RetryConfig:
    """Value object describing retry behaviour."""

    def __init__(
        self,
        max_attempts: int = 3,
        wait_min: float = 1.0,
        wait_max: float = 10.0,
        exceptions: tuple[type[Exception], ...] = (Exception,),
        jitter: bool = True,
    ) -> None:
        self.max_attempts = max_attempts
        self.wait_min = wait_min
        self.wait_max = wait_max
        self.exceptions = exceptions
        self.jitter = jitter

    def build_stop(self) -> StopBaseT:
        return stop_after_attempt(self.max_attempts)

    def build_wait(self) -> WaitBaseT:
        if self.jitter:
            return wait_random_exponential(min=self.wait_min, max=self.wait_max)
        return wait_exponential(multiplier=1, min=self.wait_min, max=self.wait_max)

    def make_decorator(self) -> Any:
        return retry(
            stop=self.build_stop(),
            wait=self.build_wait(),
            retry=retry_if_exception_type(self.exceptions),
            before_sleep=_log_retry,
            reraise=True,
        )


async def with_retry[T](
    coro: Callable[..., Awaitable[T]],
    *args: Any,
    config: RetryConfig | None = None,
    **kwargs: Any,
) -> T:
    """Execute *coro* with retry semantics described by *config*.

    Example::
        result = await with_retry(my_async_fn, arg1, config=RetryConfig(max_attempts=5))
    """
    cfg = config or RetryConfig(
        max_attempts=settings.retry_max_attempts,
        wait_min=settings.retry_wait_min_seconds,
        wait_max=settings.retry_wait_max_seconds,
    )
    async for attempt in AsyncRetrying(
        stop=cfg.build_stop(),
        wait=cfg.build_wait(),
        retry=retry_if_exception_type(cfg.exceptions),
        before_sleep=_log_retry,
        reraise=True,
    ):
        with attempt:
            return await coro(*args, **kwargs)
    # Unreachable; AsyncRetrying reraises on exhaustion.
    raise RuntimeError("Retry loop exited without a result")  # pragma: no cover


def make_retry_wrapper[T](
    func: Callable[..., Awaitable[T]],
    config: RetryConfig | None = None,
) -> Callable[..., Awaitable[T]]:
    """Wrap an async function with retry logic without modifying it in place."""
    cfg = config or RetryConfig()

    @functools.wraps(func)
    async def wrapper(*args: Any, **kwargs: Any) -> T:
        return await with_retry(func, *args, config=cfg, **kwargs)

    return wrapper
