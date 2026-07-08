"""Abstract tool interface.

Every agent tool must extend BaseTool. Agents discover and invoke tools
through the ToolRegistry without depending on concrete implementations.

A tool is a discrete, reusable capability (e.g. "search the web",
"read a file", "call an external API"). Tools are NOT implemented here;
only the contract and infrastructure are defined.
"""
from __future__ import annotations

import abc
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

# ── Parameter schema ──────────────────────────────────────────────────────────


class ToolParameterType(StrEnum):
    STRING = "string"
    INTEGER = "integer"
    FLOAT = "float"
    BOOLEAN = "boolean"
    ARRAY = "array"
    OBJECT = "object"


@dataclass(frozen=True, slots=True)
class ToolParameter:
    """Describes a single input parameter for a tool."""

    name: str
    type: ToolParameterType
    description: str
    required: bool = True
    default: Any = None


# ── I/O value objects ─────────────────────────────────────────────────────────


@dataclass
class ToolInput:
    """Validated input passed to a tool's execute method."""

    tool_name: str
    arguments: dict[str, Any]
    context: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ToolOutput:
    """Structured output returned by a tool."""

    tool_name: str
    success: bool
    result: Any
    error: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


# ── Abstract base ─────────────────────────────────────────────────────────────


class BaseTool(abc.ABC):
    """
    Abstract base class for all agent tools.

    Subclasses must implement:
    - ``name``: unique tool identifier (snake_case).
    - ``description``: human-readable description used by the LLM.
    - ``parameters``: list of ToolParameter objects describing inputs.
    - ``execute()``: async execution logic.
    """

    #: Unique snake_case identifier for this tool.
    name: str

    #: Human-readable description shown to the LLM.
    description: str

    #: Declares the inputs this tool accepts.
    parameters: list[ToolParameter] = []

    @abc.abstractmethod
    async def execute(self, tool_input: ToolInput) -> ToolOutput:
        """Execute the tool with the given input and return structured output."""
        ...

    def to_openai_schema(self) -> dict[str, Any]:
        """Render this tool as an OpenAI function-calling schema."""
        properties: dict[str, Any] = {}
        required: list[str] = []
        for param in self.parameters:
            properties[param.name] = {
                "type": param.type,
                "description": param.description,
            }
            if param.required:
                required.append(param.name)

        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                },
            },
        }

    def validate_arguments(self, arguments: dict[str, Any]) -> None:
        """Raise ValueError for missing required arguments."""
        for param in self.parameters:
            if param.required and param.name not in arguments:
                raise ValueError(
                    f"Tool '{self.name}' requires argument '{param.name}'"
                )
