import { prisma } from "../db/client.js";
import { askClaude } from "../services/claude.js";
import { notifications, sendProposalEmail } from "../services/notify.js";
import { placeFreelancerBid } from "./sources/freelancerCom.js";

const SYSTEM_PROMPT = `You are a freelance proposal writer and rate negotiator. Given a job post,
write a short, specific, non-generic proposal (120-180 words) that:
- Directly addresses the client's stated need, referencing specifics from the brief
- States a clear approach/plan in 2-3 bullet points
- Proposes a specific rate grounded in current market rates for this category/scope
  (research what similar work typically costs; don't lowball or overshoot)
- Ends with a confident, low-pressure call to action
Never use filler like "I am the perfect fit" without evidence. No emojis.
After the proposal, on a new line write "RATE: <your proposed rate as a short string>".`;

/**
 * Sources where we control the whole relationship (our own outreach/website)
 * carry no marketplace ToS restriction, so an approved-feasible job there can
 * be sent automatically. A REMOTE_BOARD posting that published an apply-by
 * -email address is the same thing — the poster explicitly invited emailed
 * applications, so emailing them a proposal is a normal job application, not
 * automated bidding. Freelancer.com has an official self-service bidding
 * API, so it auto-sends too (real bid placed, not just drafted) once
 * FREELANCER_OAUTH_TOKEN/FREELANCER_USER_ID are configured. Guru.com and
 * Upwork have no such self-service API, so they always require a human
 * tap before sending — see README for why.
 */
const ALWAYS_AUTO_SEND_SOURCES = new Set(["OUTREACH", "MANUAL"]);

function canAutoSend(job) {
  if (ALWAYS_AUTO_SEND_SOURCES.has(job.source)) return true;
  if (job.source === "REMOTE_BOARD" && job.applyEmail) return true;
  if (job.source === "FREELANCER" && process.env.FREELANCER_OAUTH_TOKEN) return true;
  return false;
}

export async function draftProposal(jobId) {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });

  const run = await prisma.agentRun.create({
    data: { agent: "PROPOSAL", jobId, status: "RUNNING" },
  });

  try {
    const raw = await askClaude(
      SYSTEM_PROMPT,
      `Job title: ${job.title}\nCategory: ${job.category}\nClient's stated budget: ${job.budget ?? "not specified"}\n\nJob description:\n${job.description}`
    );

    const rateMatch = raw.match(/RATE:\s*(.+)/i);
    const proposedRate = rateMatch ? rateMatch[1].trim() : null;
    const draftText = raw.replace(/RATE:\s*.+/i, "").trim();

    let autoSend = canAutoSend(job);
    let negotiationLog = null;

    if (autoSend && job.source === "FREELANCER") {
      const numericAmount = parseFloat(String(proposedRate).replace(/[^0-9.]/g, ""));
      const result = await placeFreelancerBid({
        projectId: job.externalMeta?.freelancerProjectId,
        amount: numericAmount || undefined,
        description: draftText,
      });
      if (!result.placed) {
        // Real money-committing action failed — never silently claim it
        // went out. Fall back to the human-approval queue instead.
        autoSend = false;
        negotiationLog = `Auto-bid failed: ${result.reason}`;
      }
    }

    const proposal = await prisma.proposal.upsert({
      where: { jobId },
      create: {
        jobId,
        draftText,
        proposedRate,
        autoSent: autoSend,
        approved: autoSend,
        approvedAt: autoSend ? new Date() : null,
        sentAt: autoSend ? new Date() : null,
        negotiationLog,
      },
      update: { draftText, proposedRate, negotiationLog },
    });

    await prisma.job.update({
      where: { id: jobId },
      data: { status: autoSend ? "PROPOSAL_SENT" : "PENDING_APPROVAL" },
    });

    if (autoSend) {
      if (job.applyEmail) {
        await sendProposalEmail({ to: job.applyEmail, subject: `Application: ${job.title}`, text: draftText });
      }
      await notifications.autoSent(job);
    } else {
      await notifications.approvalNeeded(job);
    }

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
    await notifications.agentFailed("Proposal", job.title, err);
    throw err;
  }
}

export async function approveProposal(jobId, editedText) {
  const proposal = await prisma.proposal.update({
    where: { jobId },
    data: { approved: true, approvedAt: new Date(), editedText: editedText ?? undefined, sentAt: new Date() },
  });
  await prisma.job.update({ where: { id: jobId }, data: { status: "PROPOSAL_SENT" } });
  return proposal;
}
