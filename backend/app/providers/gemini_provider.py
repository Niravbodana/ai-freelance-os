"""Gemini provider implementation via google-generativeai."""
from __future__ import annotations

from backend.app.config import settings
from backend.app.core.logging import get_logger
from backend.app.core.metrics import LLM_ERRORS, LLM_LATENCY, LLM_REQUESTS
from backend.app.core.retry import retry_llm
from backend.app.providers.base import LLMProvider, LLMRequest, LLMResponse, ProviderName

logger = get_logger(__name__)


class GeminiProvider(LLMProvider):
    """LLM provider backed by Google Gemini (google-generativeai)."""

    provider_name = ProviderName.GEMINI

    def is_available(self) -> bool:
        return bool(settings.gemini_api_key)

    def default_model(self) -> str:
        return settings.gemini_model

    @retry_llm
    async def complete(self, request: LLMRequest) -> LLMResponse:
        import google.generativeai as genai  # type: ignore[import-untyped]

        genai.configure(api_key=settings.gemini_api_key)
        model_name = request.model or self.default_model()
        model = genai.GenerativeModel(model_name)

        # Build conversation history; system message goes into system_instruction.
        system_parts = [m.content for m in request.messages if m.role == "system"]
        conversation = [
            {"role": "model" if m.role == "assistant" else m.role, "parts": [m.content]}
            for m in request.messages
            if m.role != "system"
        ]

        if system_parts:
            model = genai.GenerativeModel(
                model_name,
                system_instruction="\n\n".join(system_parts),
            )

        LLM_REQUESTS.labels(provider=self.provider_name, model=model_name).inc()
        timer = LLM_LATENCY.labels(provider=self.provider_name, model=model_name).time()
        try:
            with timer:
                chat = model.start_chat(history=conversation[:-1] if len(conversation) > 1 else [])
                last_message = conversation[-1]["parts"][0] if conversation else ""
                response = await chat.send_message_async(last_message)
        except Exception:
            LLM_ERRORS.labels(provider=self.provider_name, model=model_name).inc()
            raise

        content_text = response.text or ""
        # Gemini usage metadata may not always be present.
        usage = getattr(response, "usage_metadata", None)
        input_tokens = getattr(usage, "prompt_token_count", 0) or 0
        output_tokens = getattr(usage, "candidates_token_count", 0) or 0

        logger.debug(
            "gemini.complete",
            model=model_name,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

        return LLMResponse(
            content=content_text,
            model=model_name,
            provider=self.provider_name,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            raw={"text": content_text},
        )
