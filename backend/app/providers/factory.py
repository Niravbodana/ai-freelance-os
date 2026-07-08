"""Provider factory: resolves the correct LLMProvider by name.

No agent should instantiate a provider directly; they should always
ask the factory for the configured provider.

Usage::
    provider = ProviderFactory.get("openai")
    response = await provider.complete(request)

    # Or use the default configured in Settings.default_ai_provider:
    provider = get_default_provider()
"""
from __future__ import annotations

from backend.app.config import settings
from backend.app.core.exceptions import AppError
from backend.app.core.logging import get_logger
from backend.app.providers.anthropic_provider import AnthropicProvider
from backend.app.providers.base import LLMProvider, ProviderName
from backend.app.providers.deepseek_provider import DeepSeekProvider
from backend.app.providers.gemini_provider import GeminiProvider
from backend.app.providers.openai_provider import OpenAIProvider

logger = get_logger(__name__)

_PROVIDER_MAP: dict[ProviderName, type[LLMProvider]] = {
    ProviderName.OPENAI: OpenAIProvider,
    ProviderName.ANTHROPIC: AnthropicProvider,
    ProviderName.DEEPSEEK: DeepSeekProvider,
    ProviderName.GEMINI: GeminiProvider,
}


class ProviderNotAvailableError(AppError):
    def __init__(self, provider_name: str) -> None:
        super().__init__(
            f"Provider '{provider_name}' is not available (missing API key?)",
            "PROVIDER_NOT_AVAILABLE",
        )


class ProviderFactory:
    """Resolves and returns concrete LLMProvider instances."""

    @staticmethod
    def get(provider_name: str | ProviderName) -> LLMProvider:
        """Return a provider instance for *provider_name*.

        Raises ``AppError`` if the name is unknown or the provider lacks credentials.
        """
        try:
            name = ProviderName(provider_name)
        except ValueError:
            raise AppError(
                f"Unknown AI provider '{provider_name}'. "
                f"Valid options: {[n.value for n in ProviderName]}",
                "UNKNOWN_PROVIDER",
            ) from None

        cls = _PROVIDER_MAP[name]
        instance = cls()
        if not instance.is_available():
            raise ProviderNotAvailableError(provider_name)

        logger.debug("provider_factory.resolved", provider=name)
        return instance

    @staticmethod
    def list_available() -> list[ProviderName]:
        """Return all providers whose credentials are present in settings."""
        available: list[ProviderName] = []
        for name, cls in _PROVIDER_MAP.items():
            if cls().is_available():
                available.append(name)
        return available


def get_default_provider() -> LLMProvider:
    """Return the provider specified by ``settings.default_ai_provider``."""
    return ProviderFactory.get(settings.default_ai_provider)
