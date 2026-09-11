import { Router } from "express";
import { prisma } from "../db/client.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const paymentsRouter = Router();

function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * A plain CSV of every payment — for accounting/tax filing (GST return
 * prep, expense/income tracking) without needing to query the DB by
 * hand. Every field a bookkeeper would actually ask for.
 */
paymentsRouter.get(
  "/export.csv",
  asyncHandler(async (_req, res) => {
    const payments = await prisma.payment.findMany({
      include: { job: { select: { title: true, category: true, source: true } } },
      orderBy: { createdAt: "desc" },
    });

    const header = [
      "jobTitle",
      "category",
      "source",
      "provider",
      "amount",
      "currency",
      "status",
      "invoiceUrl",
      "dueDate",
      "paidAt",
      "clientEmail",
      "createdAt",
    ];
    const rows = payments.map((p) =>
      [
        p.job?.title,
        p.job?.category,
        p.job?.source,
        p.provider,
        p.amount,
        p.currency,
        p.status,
        p.invoiceUrl,
        p.dueDate?.toISOString() ?? "",
        p.paidAt?.toISOString() ?? "",
        p.clientEmail,
        p.createdAt.toISOString(),
      ]
        .map(csvEscape)
        .join(",")
    );

    const csv = [header.join(","), ...rows].join("\n");
    res.set("Content-Type", "text/csv");
    res.set("Content-Disposition", `attachment; filename="payments-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  })
);
