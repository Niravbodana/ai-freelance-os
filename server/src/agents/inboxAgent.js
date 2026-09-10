import { prisma } from "../db/client.js";
import { fetchNewEmails } from "../services/inbox.js";
import { askClaude } from "../services/claude.js";
import { recordProposalOutcome } from "./proposalAgent.js";
import { notifyOwner } from "../services/notify.js";
import { recordIncident } from "../services/incidents.js";

const CLASSIFY_PROMPT = `You are triaging a reply to a freelance job application email.
Reply with exactly two lines:
Line 1: one of ACCEPTED, REJECTED, COUNTER_OFFER, QUESTION, OTHER
Line 2: if COUNTER_OFFER, the countered rate (else "n/a"); if QUESTION, a concise one-paragraph
draft reply answering it professionally based on the original job context given (else "n/a")`;

/**
 * Inbox Agent — the piece that closes the loop without a human needing to
 * check email. Matches each new reply to the job whose proposal we emailed
 * (by sender address), classifies intent, and acts:
 *   ACCEPTED       → job moves to ACCEPTED (the pipeline sweep then runs
 *                     Worker → Delivery → Invoice automatically)
 *   REJECTED       → job closed, outcome recorded for performance tracking
 *   COUNTER_OFFER  → owner notified with the number; needs a real decision
 *   QUESTION/OTHER → owner notified with the message + an AI-drafted reply
 *                     to send themselves (answering exactly what was asked
 *                     is judgment-heavy enough to keep a human in the loop)
 * This only works for jobs we emailed a proposal to (REMOTE_BOARD apply-by
 * -email, or any source where applyEmail is set) — Upwork/marketplace
 * replies still need the manual mark-accepted/mark-rejected buttons.
 */
export async function processInbox() {
  const run = await prisma.agentRun.create({ data: { agent: "INBOX", status: "RUNNING" } });

  let processed = 0;
  try {
    const emails = await fetchNewEmails();

    for (const email of emails) {
      try {
        const job = await prisma.job.findFirst({
          where: { applyEmail: { equals: email.from, mode: "insensitive" }, status: "PROPOSAL_SENT" },
          include: { proposal: true },
          orderBy: { createdAt: "desc" },
        });
        if (!job) continue; // Not a reply to anything we sent — ignore.

        const verdict = await askClaude(
          CLASSIFY_PROMPT,
          `Original job: ${job.title}\n${job.description.slice(0, 1000)}\n\nOur proposed rate: ${job.proposal?.proposedRate ?? "n/a"}\n\nClient's reply:\nSubject: ${email.subject}\n${email.text}`,
          400,
          { agent: "INBOX", jobId: job.id }
        );
        const [intentLine, detailLine] = verdict.trim().split("\n");
        const intent = (intentLine || "").trim().toUpperCase();
        const detail = (detailLine || "").trim();

        if (intent === "ACCEPTED") {
          await recordProposalOutcome(job.id, "ACCEPTED");
          await notifyOwner(`Job accepted: ${job.title}`, `Client accepted. Worker/Delivery/Invoice will run automatically.`);
        } else if (intent === "REJECTED") {
          await recordProposalOutcome(job.id, "REJECTED");
          // Informational only — no action needed, this is exactly what
          // "self-healing" should look like for a normal business outcome.
        } else if (intent === "COUNTER_OFFER") {
          await prisma.proposal.update({
            where: { jobId: job.id },
            data: { outcome: "COUNTER_OFFER", outcomeAt: new Date(), negotiationLog: `Client countered: ${detail}` },
          });
          await notifyOwner(
            `Counter-offer: ${job.title}`,
            `Client countered at "${detail}" (our proposed rate was ${job.proposal?.proposedRate ?? "n/a"}). Needs your decision — open the dashboard to accept, counter again, or decline.`
          );
        } else {
          await notifyOwner(
            `Client question: ${job.title}`,
            `Client wrote:\n${email.text}\n\n${intent === "QUESTION" ? `Suggested reply (not sent — review first):\n${detail}` : "Could not confidently classify this reply — please review it directly."}`
          );
        }

        processed += 1;
      } catch (emailErr) {
        console.error("[inbox] failed to process one email (continuing with others):", emailErr);
      }
    }

    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "SUCCESS", log: `Processed ${processed} email(s)`, finishedAt: new Date() },
    });
  } catch (err) {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "FAILED", log: String(err), finishedAt: new Date() },
    });
    await recordIncident({ source: "INBOX", message: err.message || err, stack: err.stack });
    throw err;
  }

  return { processed };
}
