"""Abstract LLM provider interface.

No agent should reference a concrete provider directly; all LLM calls
go through this interface. Adding a new model is a matter of implementing
LLMProvider and registering it in the factory.
"""
from __future__ import annotations

import abc
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class ProviderName(StrEnum):
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    DEEPSEEK = "deepseek"
    GEMINI = "gemini"


# ── Value objects ─────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class LLMMessage:
    """A single message in a conversation."""

    role: str  # "system" | "user" | "assistant"
    content: str


@dataclass
class LLMRequest:
    """Input to a provider completion call."""

    messages: list[LLMMessage]
    model: str | None = None
    max_tokens: int | None = None
    temperature: float | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class LLMResponse:
    """Output from a provider completion call."""

    content: str
    model: str
    provider: ProviderName
    input_tokens: int
    output_tokens: int
    raw: dict[str, Any]

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


# ── Abstract provider ─────────────────────────────────────────────────────────


class LLMProvider(abc.ABC):
    """
    Abstract base class for all LLM providers.

    Implementors must override:
    - ``provider_name``: class-level ProviderName enum value.
    - ``complete()``: send the request and return a structured response.
    - ``is_available()``: check whether credentials are present.
    """

    provider_name: ProviderName

    @abc.abstractmethod
    async def complete(self, request: LLMRequest) -> LLMResponse:
        """Send *request* to the LLM and return a structured response."""
        ...

    @abc.abstractmethod
    def is_available(self) -> bool:
        """Return True if this provider has the necessary credentials configured."""
        ...

    def default_model(self) -> str:
        """Return the default model name for this provider."""
        raise NotImplementedError  # pragma: no cover
