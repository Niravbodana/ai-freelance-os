"""Tool registry: manages discovery and lookup of agent tools.

Tools are registered by name. Agents ask the registry for a tool and
invoke it through the common BaseTool interface, without importing
concrete tool classes.

Usage::
    registry = get_tool_registry()
    registry.register(MyTool())
    tool = registry.get("my_tool")
    output = await tool.execute(ToolInput(tool_name="my_tool", arguments={...}))
"""
from __future__ import annotations

from agents.tools.base import BaseTool, ToolInput, ToolOutput
from backend.app.core.exceptions import AppError
from backend.app.core.logging import get_logger

logger = get_logger(__name__)


class ToolNotFoundError(AppError):
    def __init__(self, tool_name: str) -> None:
        super().__init__(f"Tool '{tool_name}' is not registered", "TOOL_NOT_FOUND")


class ToolRegistry:
    """Central registry for agent tools."""

    def __init__(self) -> None:
        self._tools: dict[str, BaseTool] = {}

    def register(self, tool: BaseTool) -> None:
        """Register *tool*; overwrites any existing tool with the same name."""
        self._tools[tool.name] = tool
        logger.info("tool_registry.registered", tool_name=tool.name)

    def unregister(self, tool_name: str) -> None:
        """Remove a tool from the registry."""
        if tool_name in self._tools:
            del self._tools[tool_name]
            logger.info("tool_registry.unregistered", tool_name=tool_name)

    def get(self, tool_name: str) -> BaseTool:
        """Return the tool registered under *tool_name*."""
        tool = self._tools.get(tool_name)
        if tool is None:
            raise ToolNotFoundError(tool_name)
        return tool

    def list_tools(self) -> list[BaseTool]:
        """Return all registered tools."""
        return list(self._tools.values())

    def to_openai_schemas(self) -> list[dict[str, object]]:
        """Return all tools as OpenAI function-calling schemas."""
        return [t.to_openai_schema() for t in self._tools.values()]

    async def execute(self, tool_name: str, arguments: dict[str, object]) -> ToolOutput:
        """Look up and execute a tool by name."""
        tool = self.get(tool_name)
        tool.validate_arguments(arguments)
        tool_input = ToolInput(tool_name=tool_name, arguments=arguments)
        logger.info("tool_registry.executing", tool_name=tool_name)
        return await tool.execute(tool_input)


# ── Singleton ─────────────────────────────────────────────────────────────────

_registry: ToolRegistry | None = None


def get_tool_registry() -> ToolRegistry:
    """Return the application-wide ToolRegistry singleton."""
    global _registry
    if _registry is None:
        _registry = ToolRegistry()
    return _registry
