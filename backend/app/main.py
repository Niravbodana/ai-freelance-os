"""FastAPI application entry point."""
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware

from backend.app.api.v1.router import api_router
from backend.app.config import settings
from backend.app.core.logging import configure_logging
from backend.app.core.tracing import TraceMiddleware
from backend.app.db.base import Base
from backend.app.db.session import engine

configure_logging()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Application lifespan: startup and shutdown events."""
    del app

    # Initialise DB schema
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Boot the event bus singleton (no-op; lazy initialisation)
    from backend.app.core.events import get_event_bus
    get_event_bus()

    # Start scheduler
    from backend.app.core.scheduler import get_scheduler
    scheduler = get_scheduler()
    await scheduler.start()

    yield

    # Graceful shutdown
    await scheduler.stop()
    await engine.dispose()


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="AI Freelance Operating System – multi-agent backend",
    lifespan=lifespan,
    docs_url="/docs" if settings.app_debug else None,
    redoc_url="/redoc" if settings.app_debug else None,
)

app.add_middleware(TraceMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api/v1")


# ── Metrics endpoint ──────────────────────────────────────────────────────────

if settings.metrics_enabled:
    from backend.app.core.metrics import metrics_output

    @app.get(settings.metrics_path, include_in_schema=False)
    async def prometheus_metrics() -> Response:
        """Prometheus scrape endpoint."""
        return Response(content=metrics_output(), media_type="text/plain; version=0.0.4")
