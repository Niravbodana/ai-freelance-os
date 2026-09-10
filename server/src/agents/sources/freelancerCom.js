import { fetchWithTimeout } from "../../services/httpFetch.js";
import { getConfig } from "../../services/config.js";

/**
 * Freelancer.com official API (developers.freelancer.com) — self-service
 * OAuth apps, publicly documented, meant for exactly this kind of
 * integration. Requires:
 *   FREELANCER_OAUTH_TOKEN — token for your registered app/account
 *   FREELANCER_USER_ID     — your numeric freelancer.com user id (bidder)
 * Both optional: without them this adapter simply returns no jobs and bid
 * placement is skipped, rather than failing the whole Hunter run.
 *
 * NOTE: verify field names/endpoints against the current API docs before
 * relying on this in production — third-party API shapes drift over time
 * and this was written from documented behavior, not a live test run.
 */

const BASE = "https://www.freelancer.com/api/projects/0.1";

function authHeaders() {
  const token = getConfig("FREELANCER_OAUTH_TOKEN");
  return token ? { "Freelancer-OAuth-V1": token } : null;
}

export async function freelancerComAdapter() {
  const headers = authHeaders();
  if (!headers) return [];

  const res = await fetchWithTimeout(
    `${BASE}/projects/active/?limit=30&job_details=true&full_description=true`,
    { headers }
  );
  if (!res.ok) return [];

  const data = await res.json();
  const projects = data?.result?.projects || [];

  return projects.map((p) => ({
    source: "FREELANCER",
    externalUrl: p.seo_url ? `https://www.freelancer.com/projects/${p.seo_url}` : null,
    title: p.title,
    description: p.preview_description || p.title,
    budget: p.budget ? `${p.budget.minimum ?? ""}-${p.budget.maximum ?? ""} ${p.currency?.code ?? ""}` : null,
    category: guessCategory(p.jobs?.map((j) => j.name) || []),
    meta: { freelancerProjectId: p.id },
  }));
}

/**
 * Places a real bid via the official API. Only called for jobs the
 * Feasibility Agent already approved and the Proposal Agent already
 * drafted — this is the one place actual money-committing action happens
 * for this source, so it stays a separate, explicit call rather than
 * something a generic "send" path does implicitly.
 */
export async function placeFreelancerBid({ projectId, amount, description }) {
  const headers = authHeaders();
  const bidderId = getConfig("FREELANCER_USER_ID");
  if (!headers || !bidderId) return { placed: false, reason: "FREELANCER_OAUTH_TOKEN/FREELANCER_USER_ID not set" };

  const res = await fetchWithTimeout(`${BASE}/bids/`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: projectId,
      bidder_id: Number(bidderId),
      amount,
      period: 7,
      milestone_percentage: 100,
      description,
    }),
  });

  if (!res.ok) return { placed: false, reason: `Freelancer API returned ${res.status}` };
  return { placed: true, bid: await res.json() };
}

function guessCategory(tags) {
  const joined = tags.join(" ").toLowerCase();
  if (/copy|writ|content|blog|article/.test(joined)) return "content";
  if (/data|scrape|research|excel/.test(joined)) return "data";
  if (/dev|code|engineer|program|software|website|app/.test(joined)) return "code";
  return "other";
}
