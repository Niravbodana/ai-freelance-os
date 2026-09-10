import { prisma } from "../db/client.js";

const MIN_SAMPLES_TO_TRUST = 3;

function extractNumericRate(rateStr) {
  if (!rateStr) return null;
  const match = String(rateStr).match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

/**
 * What actually won and lost, by category — the feedback loop that lets the
 * Proposal Agent calibrate its own rate/pitch instead of guessing cold every
 * time. Returns null (nothing to add to the prompt) until there's enough
 * data to trust; a handful of samples is noise, not a lesson.
 */
export async function getPerformanceSummary(category) {
  const proposals = await prisma.proposal.findMany({
    where: { job: { category }, outcome: { in: ["ACCEPTED", "REJECTED"] } },
    select: { outcome: true, proposedRate: true },
  });

  if (proposals.length < MIN_SAMPLES_TO_TRUST) return null;

  const accepted = proposals.filter((p) => p.outcome === "ACCEPTED");
  const rejected = proposals.filter((p) => p.outcome === "REJECTED");
  const winRate = Math.round((accepted.length / proposals.length) * 100);

  const avg = (list) => {
    const rates = list.map((p) => extractNumericRate(p.proposedRate)).filter((n) => n != null);
    if (!rates.length) return null;
    return (rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(0);
  };

  const avgAccepted = avg(accepted);
  const avgRejected = avg(rejected);

  let summary = `Historical performance for "${category}" jobs: ${proposals.length} proposals with a known outcome, ${winRate}% acceptance rate.`;
  if (avgAccepted) summary += ` Accepted proposals averaged a rate of ~${avgAccepted}.`;
  if (avgRejected) summary += ` Rejected proposals averaged ~${avgRejected}.`;
  summary += " Use this to calibrate your rate and pitch — don't ignore it.";

  return summary;
}

/** Per-category win-rate table for the dashboard. */
export async function getPerformanceByCategory() {
  const proposals = await prisma.proposal.findMany({
    where: { outcome: { in: ["ACCEPTED", "REJECTED"] } },
    select: { outcome: true, job: { select: { category: true } } },
  });

  const byCategory = {};
  for (const p of proposals) {
    const cat = p.job.category;
    byCategory[cat] ??= { total: 0, accepted: 0 };
    byCategory[cat].total += 1;
    if (p.outcome === "ACCEPTED") byCategory[cat].accepted += 1;
  }

  return Object.entries(byCategory).map(([category, { total, accepted }]) => ({
    category,
    total,
    accepted,
    winRate: Math.round((accepted / total) * 100),
  }));
}
