"""Trace and correlation ID infrastructure.

Every HTTP request is assigned a ``trace_id`` (generated if absent from the
``X-Trace-Id`` header) and an optional ``correlation_id`` (read from the
``X-Correlation-Id`` header).  Both values are bound into the structlog
context so they appear in every log line emitted during request processing.

Usage
-----
Attach :class:`TraceMiddleware` to the FastAPI app in ``main.py``::

    from backend.app.core.tracing import TraceMiddleware
    app.add_middleware(TraceMiddleware)

Access the current trace context programmatically::

    from backend.app.core.tracing import get_trace_id, get_correlation_id
    tid = get_trace_id()   # str | None
    cid = get_correlation_id()  # str | None

Manually bind context (e.g. inside background tasks)::

    from backend.app.core.tracing import bind_trace_context
    bind_trace_context(trace_id="abc", correlation_id="xyz")
"""
from __future__ import annotations

from contextvars import ContextVar
from typing import Any
from uuid import uuid4

import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

_TRACE_ID_VAR: ContextVar[str | None] = ContextVar("trace_id", default=None)
_CORRELATION_ID_VAR: ContextVar[str | None] = ContextVar("correlation_id", default=None)

_TRACE_HEADER = "X-Trace-Id"
_CORRELATION_HEADER = "X-Correlation-Id"


def get_trace_id() -> str | None:
    """Return the trace ID for the current execution context."""
    return _TRACE_ID_VAR.get()


def get_correlation_id() -> str | None:
    """Return the correlation ID for the current execution context."""
    return _CORRELATION_ID_VAR.get()


def bind_trace_context(
    trace_id: str | None = None,
    correlation_id: str | None = None,
) -> None:
    """Bind trace/correlation IDs into structlog contextvars and Python contextvars."""
    tid = trace_id or str(uuid4())
    _TRACE_ID_VAR.set(tid)
    context: dict[str, Any] = {"trace_id": tid}
    if correlation_id:
        _CORRELATION_ID_VAR.set(correlation_id)
        context["correlation_id"] = correlation_id
    structlog.contextvars.bind_contextvars(**context)


def clear_trace_context() -> None:
    """Remove trace context from structlog and Python contextvars."""
    _TRACE_ID_VAR.set(None)
    _CORRELATION_ID_VAR.set(None)
    structlog.contextvars.clear_contextvars()


class TraceMiddleware(BaseHTTPMiddleware):
    """ASGI middleware that propagates or generates trace/correlation IDs.

    - Reads ``X-Trace-Id`` from incoming request headers; generates a new UUID
      if absent.
    - Reads ``X-Correlation-Id`` from incoming request headers.
    - Binds both values into the structlog context for the duration of the
      request.
    - Adds ``X-Trace-Id`` and (if present) ``X-Correlation-Id`` to the
      response headers.
    """

    async def dispatch(self, request: Request, call_next: Any) -> Response:
        trace_id = request.headers.get(_TRACE_HEADER) or str(uuid4())
        correlation_id = request.headers.get(_CORRELATION_HEADER)

        bind_trace_context(trace_id=trace_id, correlation_id=correlation_id)
        try:
            response: Response = await call_next(request)
        finally:
            clear_trace_context()

        response.headers[_TRACE_HEADER] = trace_id
        if correlation_id:
            response.headers[_CORRELATION_HEADER] = correlation_id
        return response
