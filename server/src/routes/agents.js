import { Router } from "express";
import { prisma } from "../db/client.js";
import { runHunterAgent } from "../agents/hunterAgent.js";

export const agentsRouter = Router();

agentsRouter.post("/hunter/run", async (_req, res) => {
  try {
    const result = await runHunterAgent();
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
