"""Cost Router: automatically selects the best AI provider for a task.

Routing tiers:
- SIMPLE   → cheapest available provider (e.g. DeepSeek, Gemini Flash)
- MEDIUM   → balanced provider (e.g. GPT-4o-mini, Claude Haiku)
- COMPLEX  → strongest provider (e.g. GPT-4o, Claude 3.5 Sonnet)

Every routing decision includes:
- The selected provider name and model
- The tier classification
- An explanation of why this provider was chosen
- Estimated cost per 1 000 tokens

Usage::
    router = get_cost_router()
    decision = router.route("Write a short summary")          # → SIMPLE
    decision = router.route("Analyse this complex code")       # → COMPLEX
    decision = router.route("Draft a technical document", tier=RoutingTier.MEDIUM)

    provider = decision.build_provider()  # ready-to-use LLMProvider
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from backend.app.config import settings
from backend.app.core.logging import get_logger
from backend.app.core.metrics import estimate_cost_usd

logger = get_logger(__name__)


# ── Routing tier ──────────────────────────────────────────────────────────────


class RoutingTier(StrEnum):
    SIMPLE = "simple"
    MEDIUM = "medium"
    COMPLEX = "complex"


# ── Provider catalogue ────────────────────────────────────────────────────────

# Each entry: (provider_name, model, tier, description)
_CATALOGUE: list[tuple[str, str, RoutingTier, str]] = [
    # Simple tier – cheapest
    ("deepseek", "deepseek-chat", RoutingTier.SIMPLE, "Ultra-low cost, fast responses"),
    ("gemini", "gemini-1.5-flash", RoutingTier.SIMPLE, "Low cost Google model"),
    ("openai", "gpt-4o-mini", RoutingTier.SIMPLE, "Affordable OpenAI model for lightweight tasks"),
    # Medium tier – balanced
    ("anthropic", "claude-3-haiku-20240307", RoutingTier.MEDIUM, "Fast, capable Anthropic model"),
    ("openai", "gpt-4o-mini", RoutingTier.MEDIUM, "Reliable OpenAI model for general tasks"),
    ("gemini", "gemini-1.5-pro", RoutingTier.MEDIUM, "Balanced Google model"),
    # Complex tier – strongest
    ("openai", "gpt-4o", RoutingTier.COMPLEX, "OpenAI flagship model for complex reasoning"),
    (
        "anthropic",
        "claude-3-5-sonnet-20241022",
        RoutingTier.COMPLEX,
        "Anthropic's best model for coding and analysis",
    ),
]

# Keyword signals that upgrade routing tier
_SIMPLE_KEYWORDS = frozenset(
    {"summarise", "summarize", "translate", "rewrite", "list", "simple", "short", "brief"}
)
_COMPLEX_KEYWORDS = frozenset(
    {
        "code",
        "implement",
        "debug",
        "architecture",
        "design",
        "complex",
        "analyse",
        "analyze",
        "reasoning",
        "logic",
        "algorithm",
        "security",
        "optimise",
        "optimize",
    }
)


# ── Decision ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RoutingDecision:
    """The result of a routing evaluation."""

    provider: str
    model: str
    tier: RoutingTier
    explanation: str
    estimated_cost_per_1k_input_tokens: float
    estimated_cost_per_1k_output_tokens: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "tier": self.tier,
            "explanation": self.explanation,
            "estimated_cost_per_1k_input_tokens": self.estimated_cost_per_1k_input_tokens,
            "estimated_cost_per_1k_output_tokens": self.estimated_cost_per_1k_output_tokens,
        }

    def build_provider(self) -> Any:
        """Instantiate and return the routed LLMProvider."""
        from backend.app.providers.factory import build_provider

        return build_provider(self.provider)


# ── Router ────────────────────────────────────────────────────────────────────


class CostRouter:
    """Selects the cheapest provider that satisfies the complexity tier.

    Provider availability is determined by checking whether the relevant
    API key is configured in Settings.  If a preferred provider is
    unavailable (no key), the router falls back to the next available one
    in the same tier, then to a higher tier.
    """

    def __init__(self) -> None:
        self._catalogue = list(_CATALOGUE)

    # ── Classification ────────────────────────────────────────────────────────

    def classify(self, prompt: str) -> RoutingTier:
        """Classify *prompt* into a routing tier based on keyword heuristics."""
        lower = prompt.lower()
        words = set(lower.split())

        complex_hits = words & _COMPLEX_KEYWORDS
        if complex_hits:
            return RoutingTier.COMPLEX

        simple_hits = words & _SIMPLE_KEYWORDS
        if simple_hits:
            return RoutingTier.SIMPLE

        # Default: medium
        return RoutingTier.MEDIUM

    # ── Routing ───────────────────────────────────────────────────────────────

    def route(
        self,
        prompt: str,
        *,
        tier: RoutingTier | None = None,
    ) -> RoutingDecision:
        """Select the best provider for *prompt*.

        Args:
            prompt: The task description / prompt text.
            tier:   Override the auto-classified tier.

        Returns:
            A :class:`RoutingDecision` with provider, model, explanation, and
            estimated cost.
        """
        effective_tier = tier or self.classify(prompt)
        decision = self._pick(effective_tier)
        logger.info(
            "cost_router.decision",
            provider=decision.provider,
            model=decision.model,
            tier=decision.tier,
            explanation=decision.explanation,
        )
        return decision

    def _pick(self, tier: RoutingTier) -> RoutingDecision:
        """Find the best available provider for *tier*, with fallback."""
        # Try requested tier, then escalate to higher tiers if needed
        tier_order: list[RoutingTier] = [tier]
        if tier == RoutingTier.SIMPLE:
            tier_order = [RoutingTier.SIMPLE, RoutingTier.MEDIUM, RoutingTier.COMPLEX]
        elif tier == RoutingTier.MEDIUM:
            tier_order = [RoutingTier.MEDIUM, RoutingTier.COMPLEX, RoutingTier.SIMPLE]
        # COMPLEX stays as-is – no fallback to weaker tiers

        for try_tier in tier_order:
            candidates = [e for e in self._catalogue if e[2] == try_tier]
            for provider, model, candidate_tier, description in candidates:
                if self._is_available(provider):
                    cost_in, cost_out = self._get_costs(provider, model)
                    explanation = (
                        f"{description}. "
                        f"Selected for {candidate_tier} tier. "
                        f"Est. cost: ${cost_in:.5f}/1k input, "
                        f"${cost_out:.5f}/1k output tokens."
                    )
                    return RoutingDecision(
                        provider=provider,
                        model=model,
                        tier=candidate_tier,
                        explanation=explanation,
                        estimated_cost_per_1k_input_tokens=cost_in,
                        estimated_cost_per_1k_output_tokens=cost_out,
                    )

        # Last resort: return default provider from settings
        return self._default_decision()

    def _is_available(self, provider: str) -> bool:
        """Return True if the provider's API key is configured."""
        key_map = {
            "openai": settings.openai_api_key,
            "anthropic": settings.anthropic_api_key,
            "deepseek": settings.deepseek_api_key,
            "gemini": settings.gemini_api_key,
        }
        api_key = key_map.get(provider, "")
        return bool(api_key and api_key.strip())

    @staticmethod
    def _get_costs(provider: str, model: str) -> tuple[float, float]:
        """Return (input_cost_per_1k, output_cost_per_1k) in USD."""
        # Reuse the cost table from metrics
        cost_1 = estimate_cost_usd(provider, model, 1000, 0)
        cost_0 = estimate_cost_usd(provider, model, 0, 1000)
        return cost_1, cost_0

    def _default_decision(self) -> RoutingDecision:
        provider = settings.default_ai_provider
        model_map = {
            "openai": settings.openai_model,
            "anthropic": settings.anthropic_model,
            "deepseek": settings.deepseek_model,
            "gemini": settings.gemini_model,
        }
        model = model_map.get(provider, "gpt-4o")
        cost_in, cost_out = self._get_costs(provider, model)
        return RoutingDecision(
            provider=provider,
            model=model,
            tier=RoutingTier.MEDIUM,
            explanation=f"Fallback to configured default provider '{provider}'.",
            estimated_cost_per_1k_input_tokens=cost_in,
            estimated_cost_per_1k_output_tokens=cost_out,
        )

    # ── Catalogue management ──────────────────────────────────────────────────

    def add_provider(
        self,
        provider: str,
        model: str,
        tier: RoutingTier,
        description: str,
    ) -> None:
        """Register an additional provider/model into the routing catalogue."""
        self._catalogue.append((provider, model, tier, description))
        logger.info(
            "cost_router.provider_added",
            provider=provider,
            model=model,
            tier=tier,
        )

    def list_catalogue(self) -> list[dict[str, Any]]:
        """Return the full provider catalogue as a list of dicts."""
        return [
            {
                "provider": p,
                "model": m,
                "tier": t,
                "description": d,
                "available": self._is_available(p),
            }
            for p, m, t, d in self._catalogue
        ]


# ── Singleton ─────────────────────────────────────────────────────────────────

_router: CostRouter | None = None


def get_cost_router() -> CostRouter:
    """Return the application-wide CostRouter singleton."""
    global _router
    if _router is None:
        _router = CostRouter()
    return _router
