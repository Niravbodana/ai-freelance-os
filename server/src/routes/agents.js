import { Router } from "express";
import { prisma } from "../db/client.js";
import { runHunterAgent } from "../agents/hunterAgent.js";
import { processInbox } from "../agents/inboxAgent.js";
import { advancePipeline } from "../agents/pipelineAgent.js";
import { sendWeeklyDigest } from "../agents/digestAgent.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const agentsRouter = Router();

agentsRouter.post(
  "/hunter/run",
  asyncHandler(async (_req, res) => {
    try {
      const result = await runHunterAgent();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  })
);

agentsRouter.post(
  "/inbox/run",
  asyncHandler(async (_req, res) => {
    try {
      const result = await processInbox();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  })
);

agentsRouter.post(
  "/pipeline/run",
  asyncHandler(async (_req, res) => {
    try {
      const result = await advancePipeline();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  })
);

agentsRouter.post(
  "/digest/run",
  asyncHandler(async (_req, res) => {
    try {
      const result = await sendWeeklyDigest();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  })
);

agentsRouter.get(
  "/runs",
  asyncHandler(async (_req, res) => {
    const runs = await prisma.agentRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 100,
      include: { job: { select: { title: true } } },
    });
    res.json(runs);
  })
);
