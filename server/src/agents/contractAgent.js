import { prisma } from "../db/client.js";
import { askClaude } from "../services/claude.js";
import { sendProposalEmail } from "../services/notify.js";
import { recordIncident, registerRetryHandler } from "../services/incidents.js";

const CONTRACT_PROMPT = `You are drafting a short, plain-language freelance service agreement (not
formal legal boilerplate — a clear, fair one-page agreement a small independent freelancer would
send). Include: scope of work (from the brief given), rate/total fee, payment terms (due within 7
days of delivery), what happens on revision requests (reasonable revisions included, scope changes
billed separately), and that work product/IP transfers to the client upon full payment. End with a
line asking the client to reply confirming they agree to proceed on these terms. No emojis, no
legal-firm letterhead style — plain text, professional and friendly.`;

/**
 * Contract Agent — sources without their own platform-level terms of
 * service (Upwork/Freelancer/Guru all have one covering the engagement)
 * get a simple, auto-generated service agreement emailed on acceptance.
 * This is a plain-language paper trail, not a substitute for a lawyer —
 * it exists to reduce "what did we agree to" disputes, which is exactly
 * the kind of thing that turns into an unpaid invoice.
 */
export async function sendContract(jobId) {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId }, include: { proposal: true } });

  if (job.contractSentAt) return { sent: false, reason: "already sent" };
  if (!["OUTREACH", "MANUAL"].includes(job.source)) {
    return { sent: false, reason: "platform provides its own terms of service" };
  }
  if (!job.applyEmail) return { sent: false, reason: "no client email on file" };

  const run = await prisma.agentRun.create({ data: { agent: "CONTRACT", jobId, status: "RUNNING" } });

  try {
    const contractText = await askClaude(
      CONTRACT_PROMPT,
      `Project: ${job.title}\nBrief: ${job.description}\nAgreed rate: ${job.proposal?.proposedRate ?? "as discussed"}`,
      1200,
      { agent: "CONTRACT", jobId }
    );

    await sendProposalEmail({ to: job.applyEmail, subject: `Service Agreement — ${job.title}`, text: contractText });
    await prisma.job.update({ where: { id: jobId }, data: { contractSentAt: new Date() } });

    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "SUCCESS", finishedAt: new Date() } });
    return { sent: true };
  } catch (err) {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "FAILED", log: String(err), finishedAt: new Date() },
    });
    await recordIncident({ source: "CONTRACT", jobId, message: err.message || err, stack: err.stack });
    throw err;
  }
}

registerRetryHandler("CONTRACT", sendContract);
