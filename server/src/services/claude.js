import { fetchWithTimeout } from "./httpFetch.js";
import { prisma } from "../db/client.js";
import { getConfig } from "./config.js";
import { notifyOwner } from "./notify.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export const MODELS = {
  // Simple, well-scoped classification (yes/no, pass/fail, intent) —
  // Haiku 4.5 is roughly half Sonnet 5's per-token price and easily
  // capable of these tasks. Real cost lever, unlike prompt caching here:
  // our system prompts (~100-200 tokens) sit well below every model's
  // minimum cacheable prefix (1024 tokens on Sonnet 5, 4096 on Haiku 4.5
  // — see shared/prompt-caching.md), so cache_control on them would
  // never actually cache. Model tiering is what actually saves money.
  CLASSIFY: "claude-haiku-4-5-20251001",
  // Proposal/content drafting — quality-sensitive, stays on Sonnet 5.
  GENERATE: "claude-sonnet-5",
};

// Pricing varies by model — cost is computed per-call using the rate for
// the model actually used, not one global constant.
const PRICING_PER_MTOK = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

function priceFor(model) {
  return (
    PRICING_PER_MTOK[model] || {
      input: Number(getConfig("CLAUDE_INPUT_COST_PER_MTOK")) || 3,
      output: Number(getConfig("CLAUDE_OUTPUT_COST_PER_MTOK")) || 15,
    }
  );
}

// Thinking is adaptive-on by default on Sonnet 5 (and Opus/Fable-tier
// models) — real token spend for tasks that don't need step-by-step
// reasoning. Every call this app makes is a single-turn classification or
// a direct pattern-following write, so thinking is explicitly turned off
// rather than left to its (costlier) default. Haiku 4.5 has no thinking
// unless explicitly enabled, so this only matters for the GENERATE tier.
const ADAPTIVE_THINKING_MODELS = new Set(["claude-sonnet-5"]);

// The API itself has no "remaining account quota" endpoint — this
// snapshot of the real anthropic-ratelimit-* response headers is the
// closest thing to live capacity data, and is what the dashboard shows.
let lastRateLimitSnapshot = null;
export function getRateLimitSnapshot() {
  return lastRateLimitSnapshot;
}

async function getMonthlySpend() {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const result = await prisma.usageLog.aggregate({
    where: { createdAt: { gte: monthStart } },
    _sum: { costUsd: true },
  });
  return result._sum.costUsd || 0;
}

// CLAUDE_MONTHLY_BUDGET_USD used to be display-only (shown in stats, never
// enforced) — a bug or a spam wave of low-quality leads could run spend
// unbounded. Tracks whether the 80%-of-budget warning already fired this
// month so it's a one-time heads-up, not an email per API call.
let lastBudgetWarningMonth = null;

export async function askClaude(systemPrompt, userPrompt, maxTokens = 1024, meta = {}, options = {}) {
  const apiKey = getConfig("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set — configure it in Admin Settings");

  const budget = Number(getConfig("CLAUDE_MONTHLY_BUDGET_USD")) || 0;
  if (budget > 0) {
    const spend = await getMonthlySpend();
    if (spend >= budget) {
      throw new Error(
        `Monthly Claude budget of $${budget.toFixed(2)} already spent ($${spend.toFixed(2)}) — refusing new API calls until next month or a higher budget is set in Admin Settings.`
      );
    }
    const monthKey = `${new Date().getUTCFullYear()}-${new Date().getUTCMonth()}`;
    if (spend >= budget * 0.8 && lastBudgetWarningMonth !== monthKey) {
      lastBudgetWarningMonth = monthKey;
      notifyOwner(
        "Claude API budget at 80%",
        `Spent $${spend.toFixed(2)} of your $${budget.toFixed(2)} monthly budget so far. At 100% the system stops making new API calls (proposals, feasibility checks, work) until next month or you raise the budget.`
      ).catch((err) => console.error("[claude] budget warning email failed:", err));
    }
  }

  const model = options.model || MODELS.GENERATE;
  const body = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  };
  if (ADAPTIVE_THINKING_MODELS.has(model) && options.disableThinking !== false) {
    body.thinking = { type: "disabled" };
  }

  const res = await fetchWithTimeout(
    API_URL,
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
    60_000
  );

  lastRateLimitSnapshot = {
    requestsLimit: res.headers.get("anthropic-ratelimit-requests-limit"),
    requestsRemaining: res.headers.get("anthropic-ratelimit-requests-remaining"),
    tokensLimit: res.headers.get("anthropic-ratelimit-tokens-limit"),
    tokensRemaining: res.headers.get("anthropic-ratelimit-tokens-remaining"),
    resetsAt: res.headers.get("anthropic-ratelimit-tokens-reset"),
    capturedAt: new Date().toISOString(),
  };

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const text = (data.content || []).map((block) => block.text ?? "").join("");

  const inputTokens = data.usage?.input_tokens ?? 0;
  const outputTokens = data.usage?.output_tokens ?? 0;
  const price = priceFor(model);
  const costUsd = (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;

  try {
    await prisma.usageLog.create({
      data: { agent: meta.agent || "UNKNOWN", jobId: meta.jobId ?? null, inputTokens, outputTokens, costUsd },
    });
  } catch (logErr) {
    // Never let a logging failure take down the actual agent work.
    console.error("[claude] failed to record usage log:", logErr);
  }

  return text;
}
