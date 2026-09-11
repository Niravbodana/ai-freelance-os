import { Router } from "express";
import { prisma } from "../db/client.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const clientsRouter = Router();

/**
 * The per-client rollup the dashboard's Clients tab renders: every client
 * (whether they came from a job-board apply-email, an outreach lead, or a
 * manually added job — see services/clients.js) with their job list and a
 * financial summary computed straight from Payment rows, never guessed:
 * received = sum of PAID payments, remaining = sum of invoiced-but-unpaid
 * (INVOICE_SENT/OVERDUE) payments. A client with jobs but no payment yet
 * shows 0/0, not an error.
 */
clientsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const clients = await prisma.client.findMany({
      include: {
        jobs: {
          include: { payments: true, deliverable: true },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const costByJobId = await getCostByJobId(clients.flatMap((c) => c.jobs.map((j) => j.id)));
    const result = clients.map((client) => summarizeClient(client, costByJobId));
    res.json(result);
  })
);

clientsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const client = await prisma.client.findUnique({
      where: { id: req.params.id },
      include: {
        jobs: {
          include: { payments: true, deliverable: true, proposal: true },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!client) return res.status(404).json({ error: "Client not found" });
    const costByJobId = await getCostByJobId(client.jobs.map((j) => j.id));
    res.json(summarizeClient(client, costByJobId));
  })
);

/**
 * What each job actually cost in Claude API spend — the piece stats.js's
 * monthly totals never broke down per-job, so there was no way to see
 * whether a given client/job was actually profitable without manually
 * cross-referencing UsageLog against Payment.
 */
async function getCostByJobId(jobIds) {
  if (jobIds.length === 0) return {};
  const rows = await prisma.usageLog.groupBy({
    by: ["jobId"],
    where: { jobId: { in: jobIds } },
    _sum: { costUsd: true },
  });
  return Object.fromEntries(rows.map((r) => [r.jobId, r._sum.costUsd || 0]));
}

function summarizeClient(client, costByJobId) {
  let received = 0;
  let remaining = 0;
  let aiCost = 0;
  const jobsByStatus = {};

  for (const job of client.jobs) {
    jobsByStatus[job.status] = (jobsByStatus[job.status] || 0) + 1;
    aiCost += costByJobId[job.id] || 0;
    for (const payment of job.payments) {
      if (payment.status === "PAID") received += payment.amount;
      else if (payment.status === "INVOICE_SENT" || payment.status === "OVERDUE") remaining += payment.amount;
    }
  }

  return {
    id: client.id,
    name: client.name,
    email: client.email,
    platform: client.platform,
    isRecurring: client.isRecurring,
    notes: client.notes,
    createdAt: client.createdAt,
    jobCount: client.jobs.length,
    activeJobCount: client.jobs.filter((j) => !["PAID", "REJECTED", "CLOSED", "NOT_FEASIBLE"].includes(j.status)).length,
    jobsByStatus,
    financials: {
      received: Math.round(received * 100) / 100,
      remaining: Math.round(remaining * 100) / 100,
      aiCost: Math.round(aiCost * 10000) / 10000,
      profit: Math.round((received - aiCost) * 100) / 100,
    },
    jobs: client.jobs.map((job) => ({
      id: job.id,
      title: job.title,
      status: job.status,
      category: job.category,
      source: job.source,
      statusToken: job.statusToken,
      createdAt: job.createdAt,
      deliverable: job.deliverable ? { qaPassed: job.deliverable.qaPassed, needsRevision: job.deliverable.needsRevision } : null,
      payments: job.payments.map((p) => ({ kind: p.kind, amount: p.amount, currency: p.currency, status: p.status, invoiceUrl: p.invoiceUrl, dueDate: p.dueDate })),
      aiCost: Math.round((costByJobId[job.id] || 0) * 10000) / 10000,
    })),
  };
}
