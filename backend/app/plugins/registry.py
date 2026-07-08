"""Plugin registry: discovers, loads, and unloads plugins at runtime.

Plugins are registered programmatically or by name (dotted import path).
The registry wires each plugin into the event bus and tool registry on load.

Usage::
    registry = get_plugin_registry()
    await registry.load(MyPlugin(), event_bus=bus, tool_registry=tools)
    app.include_router(registry.get_combined_router())
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import APIRouter

from backend.app.core.exceptions import AppError
from backend.app.core.logging import get_logger
from backend.app.core.metrics import PLUGINS_LOADED
from backend.app.plugins.base import BasePlugin

if TYPE_CHECKING:
    from agents.tools.registry import ToolRegistry
    from backend.app.core.events import EventBus

logger = get_logger(__name__)


class PluginAlreadyLoadedError(AppError):
    def __init__(self, plugin_name: str) -> None:
        super().__init__(f"Plugin '{plugin_name}' is already loaded", "PLUGIN_ALREADY_LOADED")


class PluginNotFoundError(AppError):
    def __init__(self, plugin_name: str) -> None:
        super().__init__(f"Plugin '{plugin_name}' is not loaded", "PLUGIN_NOT_FOUND")


class PluginRegistry:
    """Manages the lifecycle of all installed plugins."""

    def __init__(self) -> None:
        self._plugins: dict[str, BasePlugin] = {}

    async def load(
        self,
        plugin: BasePlugin,
        event_bus: EventBus,
        tool_registry: ToolRegistry,
    ) -> None:
        """Load *plugin* and wire it into the application."""
        name = plugin.metadata.name
        if name in self._plugins:
            raise PluginAlreadyLoadedError(name)

        await plugin.on_load(event_bus=event_bus, tool_registry=tool_registry)
        self._plugins[name] = plugin
        PLUGINS_LOADED.set(len(self._plugins))

        # Publish plugin loaded event
        from backend.app.core.events import EventType

        await event_bus.emit(
            EventType.PLUGIN_LOADED,
            payload={"plugin_name": name, "version": plugin.metadata.version},
            source="plugin_registry",
        )
        logger.info("plugin_registry.loaded", plugin_name=name, version=plugin.metadata.version)

    async def unload(
        self,
        plugin_name: str,
        event_bus: EventBus,
        tool_registry: ToolRegistry,
    ) -> None:
        """Unload a plugin by name."""
        plugin = self._plugins.get(plugin_name)
        if plugin is None:
            raise PluginNotFoundError(plugin_name)

        await plugin.on_unload(event_bus=event_bus, tool_registry=tool_registry)
        del self._plugins[plugin_name]
        PLUGINS_LOADED.set(len(self._plugins))

        from backend.app.core.events import EventType

        await event_bus.emit(
            EventType.PLUGIN_UNLOADED,
            payload={"plugin_name": plugin_name},
            source="plugin_registry",
        )
        logger.info("plugin_registry.unloaded", plugin_name=plugin_name)

    async def unload_all(
        self,
        event_bus: EventBus,
        tool_registry: ToolRegistry,
    ) -> None:
        """Unload all plugins (called during application shutdown)."""
        for name in list(self._plugins):
            await self.unload(name, event_bus=event_bus, tool_registry=tool_registry)

    def get(self, plugin_name: str) -> BasePlugin:
        plugin = self._plugins.get(plugin_name)
        if plugin is None:
            raise PluginNotFoundError(plugin_name)
        return plugin

    def list_plugins(self) -> list[BasePlugin]:
        return list(self._plugins.values())

    def get_combined_router(self, prefix: str = "/plugins") -> APIRouter:
        """Build an APIRouter that aggregates all plugin sub-routers."""
        combined = APIRouter(prefix=prefix, tags=["plugins"])
        for plugin in self._plugins.values():
            router = plugin.get_router()
            if router is not None:
                combined.include_router(router, prefix=f"/{plugin.metadata.name}")
        return combined


# ── Singleton ─────────────────────────────────────────────────────────────────

_registry: PluginRegistry | None = None


def get_plugin_registry() -> PluginRegistry:
    """Return the application-wide PluginRegistry singleton."""
    global _registry
    if _registry is None:
        _registry = PluginRegistry()
    return _registry
