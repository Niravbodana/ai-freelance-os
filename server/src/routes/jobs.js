import { Router } from "express";
import { prisma } from "../db/client.js";
import { checkFeasibility } from "../agents/feasibilityAgent.js";
import { draftProposal, approveProposal, recordProposalOutcome } from "../agents/proposalAgent.js";
import { runWorkerAgent } from "../agents/workerAgent.js";
import { runDeliveryAgent } from "../agents/deliveryAgent.js";
import { invoiceJob, markPaid } from "../agents/paymentAgent.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const jobsRouter = Router();

// List jobs, optionally filtered by status, newest first.
jobsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { status } = req.query;
    const jobs = await prisma.job.findMany({
      where: status ? { status: String(status) } : undefined,
      include: { proposal: true, deliverable: true, client: true, payments: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(jobs);
  })
);

// Manually add a job (outreach lead or a job copy-pasted from Upwork).
jobsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { title, description, budget, category, source, externalUrl } = req.body;
    if (!title || !description || !category || !source) {
      return res.status(400).json({ error: "title, description, category, source are required" });
    }
    const job = await prisma.job.create({
      data: { title, description, budget, category, source, externalUrl, status: "DISCOVERED" },
    });

    // Same gate as the Hunter Agent loop: check feasibility, and only draft
    // (and possibly auto-send, for outreach/manual sources) if we can deliver.
    // Errors here (e.g. a Claude API failure) are caught by asyncHandler and
    // reach the client as a proper 500 instead of hanging the request — the
    // job itself is already created and will get picked up by the next
    // Hunter Agent-style retry via the incident sweep.
    try {
      const { feasible } = await checkFeasibility(job.id);
      if (feasible) await draftProposal(job.id);
    } catch (err) {
      return res
        .status(201)
        .json({ ...(await prisma.job.findUnique({ where: { id: job.id } })), warning: `Job created, but feasibility/draft step failed and will retry automatically: ${err.message || err}` });
    }

    res.status(201).json(await prisma.job.findUnique({ where: { id: job.id }, include: { proposal: true } }));
  })
);

jobsRouter.post(
  "/:id/draft-proposal",
  asyncHandler(async (req, res) => {
    try {
      const proposal = await draftProposal(req.params.id);
      res.json(proposal);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  })
);

jobsRouter.post(
  "/:id/approve-proposal",
  asyncHandler(async (req, res) => {
    try {
      const proposal = await approveProposal(req.params.id, req.body?.editedText);
      res.json(proposal);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  })
);

// Fallback for sources the Inbox Agent can't read replies for (Upwork,
// Freelancer messaging, etc.) — same outcome recording, triggered by hand.
jobsRouter.post(
  "/:id/mark-accepted",
  asyncHandler(async (req, res) => {
    try {
      await recordProposalOutcome(req.params.id, "ACCEPTED");
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  })
);

jobsRouter.post(
  "/:id/mark-rejected",
  asyncHandler(async (req, res) => {
    try {
      await recordProposalOutcome(req.params.id, "REJECTED");
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  })
);

jobsRouter.post(
  "/:id/run-worker",
  asyncHandler(async (req, res) => {
    try {
      const deliverable = await runWorkerAgent(req.params.id);
      res.json(deliverable);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  })
);

jobsRouter.post(
  "/:id/run-delivery",
  asyncHandler(async (req, res) => {
    try {
      const result = await runDeliveryAgent(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  })
);

// Invoice a delivered job. amount/currency/clientEmail are optional overrides
// — defaults come from the approved proposal's negotiated rate.
jobsRouter.post(
  "/:id/invoice",
  asyncHandler(async (req, res) => {
    try {
      const payment = await invoiceJob(req.params.id, req.body || {});
      res.json(payment);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  })
);

// Confirm payment received (called manually, or by a provider webhook once
// wired in). Body: { kind: "DEPOSIT" | "FINAL" } — defaults to FINAL.
jobsRouter.post(
  "/:id/mark-paid",
  asyncHandler(async (req, res) => {
    try {
      await markPaid(req.params.id, req.body?.kind || "FINAL");
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  })
);
