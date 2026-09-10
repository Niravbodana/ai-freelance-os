import { fetchWithTimeout } from "./httpFetch.js";
import { prisma } from "../db/client.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-sonnet-5";

// Anthropic doesn't expose an overall account-quota endpoint, so "budget
// remaining" is self-tracked: every call's actual token usage is logged
// (see UsageLog below) against a monthly budget you set. Cost-per-token
// defaults below are placeholders — check console.anthropic.com for your
// plan's real pricing and override via env if they're off.
const INPUT_COST_PER_MTOK = Number(process.env.CLAUDE_INPUT_COST_PER_MTOK || 3);
const OUTPUT_COST_PER_MTOK = Number(process.env.CLAUDE_OUTPUT_COST_PER_MTOK || 15);

// The API *does* return real per-key rate-limit headers on every response —
// this snapshot is genuine live data, not estimated, and is what the
// dashboard's "API rate limit" tile shows.
let lastRateLimitSnapshot = null;
export function getRateLimitSnapshot() {
  return lastRateLimitSnapshot;
}

export async function askClaude(systemPrompt, userPrompt, maxTokens = 1024, meta = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const res = await fetchWithTimeout(
    API_URL,
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
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
  const costUsd =
    (inputTokens / 1_000_000) * INPUT_COST_PER_MTOK + (outputTokens / 1_000_000) * OUTPUT_COST_PER_MTOK;

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
