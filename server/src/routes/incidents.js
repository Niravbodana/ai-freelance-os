import { Router } from "express";
import { prisma } from "../db/client.js";
import { retrySweep } from "../services/incidents.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const incidentsRouter = Router();

// Default view: what's ESCALATED (needs a human) first, then still-OPEN
// (being auto-retried), newest first within each.
incidentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { status } = req.query;
    const incidents = await prisma.incident.findMany({
      where: status ? { status: String(status) } : undefined,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 200,
    });
    res.json(incidents);
  })
);

// Manually acknowledge/close an incident without another retry — e.g. you
// fixed the underlying issue yourself (added a missing API key, etc.).
incidentsRouter.post(
  "/:id/resolve",
  asyncHandler(async (req, res) => {
    const incident = await prisma.incident.update({
      where: { id: req.params.id },
      data: { status: "RESOLVED" },
    });
    res.json(incident);
  })
);

// Trigger the retry sweep on demand instead of waiting for the next 5-min cron.
incidentsRouter.post(
  "/retry-now",
  asyncHandler(async (_req, res) => {
    try {
      const result = await retrySweep();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  })
);
