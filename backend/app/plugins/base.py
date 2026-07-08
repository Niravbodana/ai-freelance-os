"""Abstract plugin interface.

Plugins extend the system without touching core code. A plugin can:
- Subscribe to event bus events.
- Register new agent tools.
- Expose new FastAPI routers.
- Run startup/shutdown logic.

Future integrations (WhatsApp, Slack, email, Zapier, etc.) will each be
a plugin that is installed and configured without modifying core modules.
"""
from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from fastapi import APIRouter

    from agents.tools.registry import ToolRegistry
    from backend.app.core.events import EventBus


@dataclass(frozen=True, slots=True)
class PluginMetadata:
    """Describes a plugin's identity and capabilities."""

    name: str
    version: str
    description: str
    author: str = "unknown"
    tags: tuple[str, ...] = ()


class BasePlugin(abc.ABC):
    """
    Abstract base class for all plugins.

    Subclasses must implement:
    - ``metadata``: return a PluginMetadata instance.
    - ``on_load()``: called when the plugin is loaded; subscribe to events, register tools.
    - ``on_unload()``: called when the plugin is unloaded; clean up subscriptions.

    Optionally override:
    - ``get_router()``: return an APIRouter to include in the FastAPI app.
    """

    @property
    @abc.abstractmethod
    def metadata(self) -> PluginMetadata:
        """Return the plugin's metadata."""
        ...

    @abc.abstractmethod
    async def on_load(
        self,
        event_bus: EventBus,
        tool_registry: ToolRegistry,
    ) -> None:
        """Initialise the plugin: subscribe to events, register tools, etc."""
        ...

    @abc.abstractmethod
    async def on_unload(
        self,
        event_bus: EventBus,
        tool_registry: ToolRegistry,
    ) -> None:
        """Tear down any resources the plugin holds."""
        ...

    def get_router(self) -> APIRouter | None:
        """Return an optional FastAPI router to include in the main app."""
        return None
