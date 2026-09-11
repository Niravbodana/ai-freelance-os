import { prisma } from "../db/client.js";
import { notifyOwner } from "../services/notify.js";
import { recordIncident } from "../services/incidents.js";

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

    await notifyOwner("Weekly summary", lines.join("\n"));
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "SUCCESS", finishedAt: new Date() } });
    return { jobsAccepted, revenueCollected: paidThisWeek._sum.amount || 0 };
  } catch (err) {
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "FAILED", log: String(err), finishedAt: new Date() } });
    await recordIncident({ source: "DIGEST", message: err.message || err, stack: err.stack, maxRetries: 0 });
    throw err;
  }
}
