import { Router } from "express";
import { prisma } from "../db/client.js";
import { getRateLimitSnapshot } from "../services/claude.js";
import { getPerformanceByCategory } from "../services/performance.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const statsRouter = Router();

const MONTHLY_BUDGET_USD = process.env.CLAUDE_MONTHLY_BUDGET_USD
  ? Number(process.env.CLAUDE_MONTHLY_BUDGET_USD)
  : null;

/**
 * One call for everything the dashboard's summary bar needs — job counts by
 * status, pending-approval count (the number that actually needs a human),
 * revenue collected/outstanding, recurring client count, Claude usage/cost
 * this month, live API rate-limit headroom, and open incident counts. This
 * is the "command centre at a glance" view — the whole operation's state
 * and how much of "you" (Claude) it's using, in one call.
 */
statsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [
      statusCounts,
      recurringClients,
      paidPayments,
      outstandingPayments,
      overduePayments,
      usageThisMonth,
      escalatedIncidents,
      openIncidents,
    ] = await Promise.all([
      prisma.job.groupBy({ by: ["status"], _count: { status: true } }),
      prisma.client.count({ where: { isRecurring: true } }),
      prisma.payment.aggregate({ where: { status: "PAID" }, _sum: { amount: true } }),
      prisma.payment.aggregate({ where: { status: { in: ["INVOICE_SENT", "OVERDUE"] } }, _sum: { amount: true } }),
      prisma.payment.count({ where: { status: "OVERDUE" } }),
      prisma.usageLog.aggregate({
        where: { createdAt: { gte: startOfMonth } },
        _sum: { inputTokens: true, outputTokens: true, costUsd: true },
      }),
      prisma.incident.count({ where: { status: "ESCALATED" } }),
      prisma.incident.count({ where: { status: "OPEN" } }),
    ]);

    const performanceByCategory = await getPerformanceByCategory();

    const byStatus = Object.fromEntries(statusCounts.map((s) => [s.status, s._count.status]));
    const costUsed = usageThisMonth._sum.costUsd || 0;

    res.json({
      jobsByStatus: byStatus,
      pendingApprovalCount: byStatus.PENDING_APPROVAL || 0,
      overduePaymentCount: overduePayments,
      recurringClients,
      revenue: {
        collected: paidPayments._sum.amount || 0,
        outstanding: outstandingPayments._sum.amount || 0,
      },
      claudeUsage: {
        inputTokensThisMonth: usageThisMonth._sum.inputTokens || 0,
        outputTokensThisMonth: usageThisMonth._sum.outputTokens || 0,
        estimatedCostThisMonth: costUsed,
        monthlyBudgetUsd: MONTHLY_BUDGET_USD,
        budgetRemainingUsd: MONTHLY_BUDGET_USD != null ? MONTHLY_BUDGET_USD - costUsed : null,
        // Real, live data straight from the API's own rate-limit headers —
        // null until the first Claude call of this process has run.
        apiRateLimit: getRateLimitSnapshot(),
      },
      incidents: {
        escalated: escalatedIncidents,
        autoRetrying: openIncidents,
      },
      performanceByCategory,
    });
  })
);
