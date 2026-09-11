import { prisma } from "../db/client.js";
import { notifyOwner } from "../services/notify.js";
import { recordIncident } from "../services/incidents.js";
import { SUPPORTED_CATEGORIES } from "./workerAgent.js";

const OPPORTUNITY_MIN_COUNT = 5;

/**
 * The safe version of "self-improve" — this never changes what the system
 * claims it can deliver on its own (that stays a deliberate, human call,
 * same as CAPABILITY_STATEMENT/SUPPORTED_CATEGORIES always have been).
 * What it *can* do unsupervised is notice patterns and report them: which
 * out-of-scope categories keep showing up in volume, worth a human
 * deciding whether to build support for. Pure reporting, no action taken.
 */
async function scanGrowthOpportunities(weekAgo) {
  const rejected = await prisma.job.groupBy({
    by: ["category"],
    where: { status: "NOT_FEASIBLE", createdAt: { gte: weekAgo }, category: { notIn: SUPPORTED_CATEGORIES } },
    _count: { category: true },
  });

  return rejected
    .filter((r) => r._count.category >= OPPORTUNITY_MIN_COUNT)
    .sort((a, b) => b._count.category - a._count.category)
    .map((r) => `- "${r.category}": ${r._count.category} jobs seen this week we currently skip — worth considering?`);
}

/**
 * Weekly Digest Agent — the "you don't have to check the dashboard" agent.
 * Every Monday, one email summarizing the past week: jobs won, revenue
 * collected, what's overdue, what's escalated. Passive by design — no
 * dashboard visit required to stay on top of the business.
 */
export async function sendWeeklyDigest() {
  const run = await prisma.agentRun.create({ data: { agent: "DIGEST", status: "RUNNING" } });

  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [jobsAccepted, paidThisWeek, escalatedIncidents, overduePayments, pendingApprovals, newTestimonialsSent] =
      await Promise.all([
        prisma.job.count({ where: { updatedAt: { gte: weekAgo }, status: { in: ["ACCEPTED", "IN_PROGRESS", "DELIVERED", "AWAITING_PAYMENT", "PAID"] } } }),
        prisma.payment.aggregate({ where: { status: "PAID", paidAt: { gte: weekAgo } }, _sum: { amount: true }, _count: true }),
        prisma.incident.count({ where: { status: "ESCALATED" } }),
        prisma.payment.count({ where: { status: "OVERDUE" } }),
        prisma.job.count({ where: { status: "PENDING_APPROVAL" } }),
        prisma.payment.count({ where: { testimonialRequestedAt: { gte: weekAgo } } }),
      ]);

    const opportunities = await scanGrowthOpportunities(weekAgo);

    const lines = [
      `Weekly summary (last 7 days):`,
      ``,
      `Jobs won/active: ${jobsAccepted}`,
      `Revenue collected: $${(paidThisWeek._sum.amount || 0).toFixed(0)} (${paidThisWeek._count} payment(s))`,
      `Testimonial requests sent: ${newTestimonialsSent}`,
      ``,
      `Needs your attention right now:`,
      `- ${pendingApprovals} proposal(s) waiting on your approval`,
      `- ${overduePayments} payment(s) overdue`,
      `- ${escalatedIncidents} incident(s) escalated`,
      ``,
      `Open the dashboard for details on any of the above.`,
    ];

    if (opportunities.length > 0) {
      lines.push(
        ``,
        `Growth opportunities (categories we're skipping in real volume):`,
        ...opportunities,
        `We only take on categories you've explicitly approved — this is FYI, not an automatic change.`
      );
    }

    await notifyOwner("Weekly summary", lines.join("\n"));
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "SUCCESS", finishedAt: new Date() } });
    return { jobsAccepted, revenueCollected: paidThisWeek._sum.amount || 0 };
  } catch (err) {
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "FAILED", log: String(err), finishedAt: new Date() } });
    await recordIncident({ source: "DIGEST", message: err.message || err, stack: err.stack, maxRetries: 0 });
    throw err;
  }
}
