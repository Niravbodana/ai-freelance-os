import { Router } from "express";
import { prisma } from "../db/client.js";
import { checkFeasibility } from "../agents/feasibilityAgent.js";
import { draftProposal, approveProposal } from "../agents/proposalAgent.js";
import { runWorkerAgent } from "../agents/workerAgent.js";
import { runDeliveryAgent } from "../agents/deliveryAgent.js";
import { invoiceJob, markPaid } from "../agents/paymentAgent.js";

export const jobsRouter = Router();

// List jobs, optionally filtered by status, newest first.
jobsRouter.get("/", async (req, res) => {
  const { status } = req.query;
  const jobs = await prisma.job.findMany({
    where: status ? { status: String(status) } : undefined,
    include: { proposal: true, deliverable: true, client: true, payment: true },
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

  // Same gate as the Hunter Agent loop: check feasibility, and only draft
  // (and possibly auto-send, for outreach/manual sources) if we can deliver.
  const { feasible } = await checkFeasibility(job.id);
  if (feasible) await draftProposal(job.id);

  res.status(201).json(await prisma.job.findUnique({ where: { id: job.id }, include: { proposal: true } }));
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

// Invoice a delivered job. amount/currency/clientEmail are optional overrides
// — defaults come from the approved proposal's negotiated rate.
jobsRouter.post("/:id/invoice", async (req, res) => {
  try {
    const payment = await invoiceJob(req.params.id, req.body || {});
    res.json(payment);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Confirm payment received (called manually, or by a provider webhook once wired in).
jobsRouter.post("/:id/mark-paid", async (req, res) => {
  try {
    await markPaid(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
