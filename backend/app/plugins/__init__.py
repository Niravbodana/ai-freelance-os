"""Plugin system public exports."""
from backend.app.plugins.base import BasePlugin, PluginMetadata
from backend.app.plugins.registry import PluginRegistry, get_plugin_registry

__all__ = [
    "BasePlugin",
    "PluginMetadata",
    "PluginRegistry",
    "get_plugin_registry",
]
