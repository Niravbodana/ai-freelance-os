import { Router } from "express";
import { prisma } from "../db/client.js";
import { runHunterAgent } from "../agents/hunterAgent.js";
import { processInbox } from "../agents/inboxAgent.js";
import { advancePipeline } from "../agents/pipelineAgent.js";

export const agentsRouter = Router();

agentsRouter.post("/hunter/run", async (_req, res) => {
  try {
    const result = await runHunterAgent();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

agentsRouter.post("/inbox/run", async (_req, res) => {
  try {
    const result = await processInbox();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

agentsRouter.post("/pipeline/run", async (_req, res) => {
  try {
    const result = await advancePipeline();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

agentsRouter.get("/runs", async (_req, res) => {
  const runs = await prisma.agentRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 100,
    include: { job: { select: { title: true } } },
  });
  res.json(runs);
});
