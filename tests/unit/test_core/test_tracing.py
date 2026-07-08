"""Tests for TraceMiddleware and tracing helpers."""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from backend.app.core.tracing import (
    TraceMiddleware,
    bind_trace_context,
    clear_trace_context,
    get_correlation_id,
    get_trace_id,
)


async def _echo(request: Request) -> PlainTextResponse:
    return PlainTextResponse(f"{get_trace_id()}|{get_correlation_id()}")


_app = Starlette(routes=[Route("/", _echo)])
_app.add_middleware(TraceMiddleware)


@pytest.fixture()
async def client() -> AsyncClient:
    transport = ASGITransport(app=_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


class TestTraceMiddleware:
    async def test_trace_id_generated_when_absent(self, client: AsyncClient) -> None:
        response = await client.get("/")
        assert response.status_code == 200
        assert "X-Trace-Id" in response.headers
        # The trace id must be a valid UUID (36 chars)
        trace_id = response.headers["X-Trace-Id"]
        assert len(trace_id) == 36

    async def test_trace_id_propagated_from_request(self, client: AsyncClient) -> None:
        custom_tid = "my-trace-id-123"
        response = await client.get("/", headers={"X-Trace-Id": custom_tid})
        assert response.headers["X-Trace-Id"] == custom_tid
        body = response.text
        assert body.startswith(custom_tid)

    async def test_correlation_id_propagated(self, client: AsyncClient) -> None:
        cid = "corr-abc"
        response = await client.get(
            "/", headers={"X-Trace-Id": "tid-1", "X-Correlation-Id": cid}
        )
        assert response.headers.get("X-Correlation-Id") == cid
        body = response.text
        assert body.endswith(cid)

    async def test_no_correlation_id_header_not_set(self, client: AsyncClient) -> None:
        response = await client.get("/", headers={"X-Trace-Id": "tid-only"})
        assert "X-Correlation-Id" not in response.headers


class TestBindClearContext:
    def test_bind_sets_context_vars(self) -> None:
        bind_trace_context(trace_id="abc", correlation_id="xyz")
        assert get_trace_id() == "abc"
        assert get_correlation_id() == "xyz"
        clear_trace_context()

    def test_clear_removes_context(self) -> None:
        bind_trace_context(trace_id="abc")
        clear_trace_context()
        assert get_trace_id() is None

    def test_bind_generates_trace_id_when_none(self) -> None:
        clear_trace_context()
        bind_trace_context()
        tid = get_trace_id()
        assert tid is not None
        assert len(tid) == 36
        clear_trace_context()
