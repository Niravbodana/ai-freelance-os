"""Tests for metrics: cost estimation and token tracking."""
from __future__ import annotations

from backend.app.core.metrics import estimate_cost_usd, record_llm_usage


class TestEstimateCost:
    def test_known_model_returns_nonzero(self) -> None:
        cost = estimate_cost_usd("openai", "gpt-4o", input_tokens=1000, output_tokens=500)
        assert cost > 0

    def test_unknown_provider_returns_zero(self) -> None:
        cost = estimate_cost_usd("unknown_provider", "unknown-model", 1000, 500)
        assert cost == 0.0

    def test_unknown_model_returns_zero(self) -> None:
        cost = estimate_cost_usd("openai", "gpt-99-ultra", 1000, 500)
        assert cost == 0.0

    def test_zero_tokens_returns_zero(self) -> None:
        cost = estimate_cost_usd("openai", "gpt-4o", 0, 0)
        assert cost == 0.0

    def test_anthropic_model(self) -> None:
        cost = estimate_cost_usd(
            "anthropic", "claude-3-5-sonnet-20241022", input_tokens=2000, output_tokens=1000
        )
        assert cost > 0

    def test_deepseek_model(self) -> None:
        cost = estimate_cost_usd("deepseek", "deepseek-chat", 1000, 1000)
        assert cost > 0


class TestRecordLlmUsage:
    def test_returns_estimated_cost(self) -> None:
        cost = record_llm_usage("openai", "gpt-4o", input_tokens=100, output_tokens=50)
        assert isinstance(cost, float)
        assert cost >= 0

    def test_zero_cost_for_unknown_model(self) -> None:
        cost = record_llm_usage("???", "???-model", 100, 50)
        assert cost == 0.0
