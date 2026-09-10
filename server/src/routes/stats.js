import { Router } from "express";
import { prisma } from "../db/client.js";

export const statsRouter = Router();

/**
 * One call for everything the dashboard's summary bar needs — job counts by
 * status, pending-approval count (the number that actually needs a human),
 * revenue collected/outstanding, and recurring client count. This is the
 * "command centre at a glance" view.
 */
statsRouter.get("/", async (_req, res) => {
  const [statusCounts, recurringClients, paidPayments, outstandingPayments, overduePayments] = await Promise.all([
    prisma.job.groupBy({ by: ["status"], _count: { status: true } }),
    prisma.client.count({ where: { isRecurring: true } }),
    prisma.payment.aggregate({ where: { status: "PAID" }, _sum: { amount: true } }),
    prisma.payment.aggregate({ where: { status: { in: ["INVOICE_SENT", "OVERDUE"] } }, _sum: { amount: true } }),
    prisma.payment.count({ where: { status: "OVERDUE" } }),
  ]);

  const byStatus = Object.fromEntries(statusCounts.map((s) => [s.status, s._count.status]));

  res.json({
    jobsByStatus: byStatus,
    pendingApprovalCount: byStatus.PENDING_APPROVAL || 0,
    overduePaymentCount: overduePayments,
    recurringClients,
    revenue: {
      collected: paidPayments._sum.amount || 0,
      outstanding: outstandingPayments._sum.amount || 0,
    },
  });
});
