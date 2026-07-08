"""Tests for CostRouter: classification and provider selection."""
from __future__ import annotations

import pytest

from backend.app.core.cost_router import CostRouter, RoutingDecision, RoutingTier


@pytest.fixture()
def router() -> CostRouter:
    return CostRouter()


class TestClassify:
    def test_simple_keywords(self, router: CostRouter) -> None:
        assert router.classify("Please summarize this document") == RoutingTier.SIMPLE

    def test_complex_keywords(self, router: CostRouter) -> None:
        assert router.classify("Implement a sorting algorithm") == RoutingTier.COMPLEX

    def test_default_medium(self, router: CostRouter) -> None:
        assert router.classify("Tell me about the history of Rome") == RoutingTier.MEDIUM

    def test_complex_wins_over_simple(self, router: CostRouter) -> None:
        # Both keywords present; complex should win
        assert router.classify("summarize the algorithm") == RoutingTier.COMPLEX

    def test_analyze_is_complex(self, router: CostRouter) -> None:
        assert router.classify("analyze this code for bugs") == RoutingTier.COMPLEX

    def test_translate_is_simple(self, router: CostRouter) -> None:
        assert router.classify("translate this text to Spanish") == RoutingTier.SIMPLE


class TestRoute:
    def test_returns_routing_decision(self, router: CostRouter) -> None:
        decision = router.route("Write a short poem")
        assert isinstance(decision, RoutingDecision)

    def test_tier_override(self, router: CostRouter) -> None:
        decision = router.route("anything", tier=RoutingTier.COMPLEX)
        # tier should be COMPLEX or fallback but never SIMPLE
        assert decision.tier in {RoutingTier.COMPLEX, RoutingTier.MEDIUM}

    def test_decision_has_explanation(self, router: CostRouter) -> None:
        decision = router.route("do something")
        assert len(decision.explanation) > 0

    def test_decision_has_cost_fields(self, router: CostRouter) -> None:
        decision = router.route("summarize")
        assert decision.estimated_cost_per_1k_input_tokens >= 0
        assert decision.estimated_cost_per_1k_output_tokens >= 0

    def test_to_dict(self, router: CostRouter) -> None:
        d = router.route("translate this").to_dict()
        assert "provider" in d
        assert "model" in d
        assert "tier" in d
        assert "explanation" in d


class TestCatalogue:
    def test_list_catalogue_returns_entries(self, router: CostRouter) -> None:
        catalogue = router.list_catalogue()
        assert len(catalogue) > 0
        entry = catalogue[0]
        assert "provider" in entry
        assert "tier" in entry

    def test_add_provider_appears_in_catalogue(self, router: CostRouter) -> None:
        router.add_provider("test_provider", "test-model", RoutingTier.SIMPLE, "A test provider")
        catalogue = router.list_catalogue()
        providers = [e["provider"] for e in catalogue]
        assert "test_provider" in providers


class TestDefaultFallback:
    def test_fallback_when_no_keys(self) -> None:
        """When no API keys are set, router falls back to default provider."""
        r = CostRouter()
        # Monkeypatch _is_available to always return False
        r._is_available = lambda p: False  # type: ignore[method-assign]
        decision = r.route("anything")
        # Should not raise; returns the default decision
        assert isinstance(decision, RoutingDecision)
