"""OpenAI provider implementation."""
from __future__ import annotations

from typing import Any

from backend.app.config import settings
from backend.app.core.logging import get_logger
from backend.app.core.metrics import LLM_ERRORS, LLM_LATENCY, LLM_REQUESTS
from backend.app.core.retry import retry_llm
from backend.app.providers.base import (
    LLMProvider,
    LLMRequest,
    LLMResponse,
    ProviderName,
)

logger = get_logger(__name__)


class OpenAIProvider(LLMProvider):
    """LLM provider backed by the OpenAI Chat Completions API."""

    provider_name = ProviderName.OPENAI

    def is_available(self) -> bool:
        return bool(settings.openai_api_key)

    def default_model(self) -> str:
        return settings.openai_model

    @retry_llm
    async def complete(self, request: LLMRequest) -> LLMResponse:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=settings.openai_api_key)
        model = request.model or self.default_model()
        messages: list[dict[str, Any]] = [
            {"role": m.role, "content": m.content} for m in request.messages
        ]

        LLM_REQUESTS.labels(provider=self.provider_name, model=model).inc()
        timer = LLM_LATENCY.labels(provider=self.provider_name, model=model).time()
        try:
            with timer:
                response = await client.chat.completions.create(
                    model=model,
                    messages=messages,  # type: ignore[arg-type]
                    max_tokens=request.max_tokens or settings.openai_max_tokens,
                    temperature=request.temperature
                    if request.temperature is not None
                    else settings.openai_temperature,
                    **request.extra,
                )
        except Exception:
            LLM_ERRORS.labels(provider=self.provider_name, model=model).inc()
            raise

        choice = response.choices[0]
        usage = response.usage

        logger.debug(
            "openai.complete",
            model=model,
            input_tokens=usage.prompt_tokens if usage else 0,
            output_tokens=usage.completion_tokens if usage else 0,
        )

        return LLMResponse(
            content=choice.message.content or "",
            model=model,
            provider=self.provider_name,
            input_tokens=usage.prompt_tokens if usage else 0,
            output_tokens=usage.completion_tokens if usage else 0,
            raw=response.model_dump(),
        )
