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

    const result = clients.map((client) => summarizeClient(client));
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
    res.json(summarizeClient(client));
  })
);

function summarizeClient(client) {
  let received = 0;
  let remaining = 0;
  const jobsByStatus = {};

  for (const job of client.jobs) {
    jobsByStatus[job.status] = (jobsByStatus[job.status] || 0) + 1;
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
    })),
  };
}
