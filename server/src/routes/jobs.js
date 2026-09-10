import { Router } from "express";
import { prisma } from "../db/client.js";
import { draftProposal, approveProposal } from "../agents/proposalAgent.js";
import { runWorkerAgent } from "../agents/workerAgent.js";
import { runDeliveryAgent } from "../agents/deliveryAgent.js";

export const jobsRouter = Router();

// List jobs, optionally filtered by status, newest first.
jobsRouter.get("/", async (req, res) => {
  const { status } = req.query;
  const jobs = await prisma.job.findMany({
    where: status ? { status: String(status) } : undefined,
    include: { proposal: true, deliverable: true, client: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(jobs);
});

// Manually add a job (outreach lead or a job copy-pasted from Upwork).
jobsRouter.post("/", async (req, res) => {
  const { title, description, budget, category, source, externalUrl } = req.body;
  if (!title || !description || !category || !source) {
    return res.status(400).json({ error: "title, description, category, source are required" });
  }
  const job = await prisma.job.create({
    data: { title, description, budget, category, source, externalUrl, status: "DISCOVERED" },
  });
  res.status(201).json(job);
});

jobsRouter.post("/:id/draft-proposal", async (req, res) => {
  try {
    const proposal = await draftProposal(req.params.id);
    res.json(proposal);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

jobsRouter.post("/:id/approve-proposal", async (req, res) => {
  try {
    const proposal = await approveProposal(req.params.id, req.body?.editedText);
    res.json(proposal);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

jobsRouter.post("/:id/run-worker", async (req, res) => {
  try {
    const deliverable = await runWorkerAgent(req.params.id);
    res.json(deliverable);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

jobsRouter.post("/:id/run-delivery", async (req, res) => {
  try {
    const result = await runDeliveryAgent(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
