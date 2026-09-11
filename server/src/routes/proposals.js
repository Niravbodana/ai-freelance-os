import { Router } from "express";
import { prisma } from "../db/client.js";
import { approveProposal, recordProposalOutcome } from "../agents/proposalAgent.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const proposalsRouter = Router();

/**
 * One place for every proposal the system has ever drafted, whatever job
 * status it's currently at — a dedicated "Proposals" tab instead of
 * hunting through the Jobs list for the ones waiting on you. Grouped by
 * outcome so "needs your approval" is always the first thing visible.
 */
proposalsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const proposals = await prisma.proposal.findMany({
      include: { job: { select: { id: true, title: true, category: true, source: true, status: true, applyEmail: true, statusToken: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(proposals);
  })
);

proposalsRouter.post(
  "/:jobId/approve",
  asyncHandler(async (req, res) => {
    const proposal = await approveProposal(req.params.jobId, req.body?.editedText);
    res.json(proposal);
  })
);

proposalsRouter.post(
  "/:jobId/reject",
  asyncHandler(async (req, res) => {
    await recordProposalOutcome(req.params.jobId, "REJECTED");
    res.json({ ok: true });
  })
);
