import { prisma } from "../db/client.js";
import { askClaude } from "../services/claude.js";

const SYSTEM_PROMPT = `You are a freelance proposal writer. Given a job post, write a short,
specific, non-generic proposal (120-180 words) that:
- Directly addresses the client's stated need, referencing specifics from the brief
- States a clear approach/plan in 2-3 bullet points
- Ends with a confident, low-pressure call to action
Never use filler like "I am the perfect fit" without evidence. No emojis.`;

/**
 * Proposal Agent — drafts a proposal for a discovered job and puts it in the
 * PENDING_APPROVAL queue. Nothing is sent automatically: a human reviews and
 * approves via the dashboard (send_mode = human-approval, by design — see
 * platform ToS notes in README).
 */
export async function draftProposal(jobId) {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });

  const run = await prisma.agentRun.create({
    data: { agent: "PROPOSAL", jobId, status: "RUNNING" },
  });

  try {
    const draftText = await askClaude(
      SYSTEM_PROMPT,
      `Job title: ${job.title}\nCategory: ${job.category}\nBudget: ${job.budget ?? "not specified"}\n\nJob description:\n${job.description}`
    );

    const proposal = await prisma.proposal.upsert({
      where: { jobId },
      create: { jobId, draftText },
      update: { draftText },
    });

    await prisma.job.update({ where: { id: jobId }, data: { status: "PENDING_APPROVAL" } });
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "SUCCESS", finishedAt: new Date() },
    });

    return proposal;
  } catch (err) {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "FAILED", log: String(err), finishedAt: new Date() },
    });
    throw err;
  }
}

export async function approveProposal(jobId, editedText) {
  const proposal = await prisma.proposal.update({
    where: { jobId },
    data: { approved: true, approvedAt: new Date(), editedText: editedText ?? undefined },
  });
  await prisma.job.update({ where: { id: jobId }, data: { status: "PROPOSAL_SENT" } });
  return proposal;
}
