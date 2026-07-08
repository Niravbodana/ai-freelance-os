"""Anthropic provider implementation."""
from __future__ import annotations

from backend.app.config import settings
from backend.app.core.logging import get_logger
from backend.app.core.metrics import LLM_ERRORS, LLM_LATENCY, LLM_REQUESTS
from backend.app.core.retry import retry_llm
from backend.app.providers.base import LLMProvider, LLMRequest, LLMResponse, ProviderName

logger = get_logger(__name__)


class AnthropicProvider(LLMProvider):
    """LLM provider backed by the Anthropic Messages API."""

    provider_name = ProviderName.ANTHROPIC

    def is_available(self) -> bool:
        return bool(settings.anthropic_api_key)

    def default_model(self) -> str:
        return settings.anthropic_model

    @retry_llm
    async def complete(self, request: LLMRequest) -> LLMResponse:
        import anthropic

        client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
        model = request.model or self.default_model()

        # Anthropic separates system from conversation messages.
        system_parts = [m.content for m in request.messages if m.role == "system"]
        conversation = [
            {"role": m.role, "content": m.content}
            for m in request.messages
            if m.role != "system"
        ]
        system_text = "\n\n".join(system_parts) if system_parts else anthropic.NOT_GIVEN

        LLM_REQUESTS.labels(provider=self.provider_name, model=model).inc()
        timer = LLM_LATENCY.labels(provider=self.provider_name, model=model).time()
        try:
            with timer:
                response = await client.messages.create(
                    model=model,
                    system=system_text,  # type: ignore[arg-type]
                    messages=conversation,  # type: ignore[arg-type]
                    max_tokens=request.max_tokens or settings.anthropic_max_tokens,
                    **request.extra,
                )
        except Exception:
            LLM_ERRORS.labels(provider=self.provider_name, model=model).inc()
            raise

        content_text = "".join(
            block.text for block in response.content if hasattr(block, "text")
        )
        input_tokens = response.usage.input_tokens if response.usage else 0
        output_tokens = response.usage.output_tokens if response.usage else 0

        logger.debug(
            "anthropic.complete",
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

        return LLMResponse(
            content=content_text,
            model=model,
            provider=self.provider_name,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            raw=response.model_dump(),
        )
