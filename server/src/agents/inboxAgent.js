import { prisma } from "../db/client.js";
import { fetchNewEmails } from "../services/inbox.js";
import { askClaude, MODELS } from "../services/claude.js";
import { recordProposalOutcome } from "./proposalAgent.js";
import { notifyOwner, sendProposalEmail } from "../services/notify.js";
import { recordIncident } from "../services/incidents.js";

// A counter-offer at or above this fraction of our original ask gets
// auto-accepted and confirmed with the client immediately — closing a deal
// fast is worth more than the last few percent of rate, and it keeps the
// loop unattended for the common case (client wants a small discount).
// Anything below this band still needs a real decision from the owner.
const ACCEPTABLE_COUNTER_BAND = 0.2; // accept down to 20% below our ask

// Revisions beyond this many auto-loop straight to the owner instead of
// Worker Agent — a client who's still unhappy after 2 free rounds needs a
// real decision (refund the deposit, negotiate a paid extra round, walk
// away), not more unattended AI work that might never satisfy them.
const REVISION_FREE_ROUNDS = 2;

function extractRate(str) {
  if (!str) return null;
  const match = String(str).match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

const PRE_DELIVERY_PROMPT = `You are triaging a reply to a freelance job application email.
Reply with exactly two lines:
Line 1: one of ACCEPTED, REJECTED, COUNTER_OFFER, QUESTION, OTHER
Line 2: if COUNTER_OFFER, the countered rate (else "n/a"); if QUESTION, a concise one-paragraph
draft reply answering it professionally based on the original job context given (else "n/a")`;

const POST_DELIVERY_PROMPT = `You are triaging a client's reply after we delivered completed
freelance work (and possibly sent an invoice). Reply with exactly two lines:
Line 1: one of SATISFIED, REVISION_REQUEST, QUESTION, OTHER
Line 2: if REVISION_REQUEST, a concise summary of exactly what they want changed (else "n/a");
if QUESTION, a concise one-paragraph draft reply (else "n/a")`;

const PRE_DELIVERY_STATUSES = ["PROPOSAL_SENT"];
const POST_DELIVERY_STATUSES = ["DELIVERED", "AWAITING_PAYMENT"];

/**
 * Inbox Agent — the piece that closes the loop without a human needing to
 * check email. Matches each new reply to the job whose proposal we emailed
 * (by sender address), classifies intent based on what stage the job is
 * at, and acts:
 *
 * Before delivery (PROPOSAL_SENT):
 *   ACCEPTED       → job moves to ACCEPTED (the pipeline sweep then runs
 *                     Contract → Worker → Delivery → Invoice automatically)
 *   REJECTED       → job closed, outcome recorded for performance tracking
 *   COUNTER_OFFER  → auto-negotiated within a band (see
 *                     ACCEPTABLE_COUNTER_BAND), otherwise owner decides
 *   QUESTION/OTHER → owner notified with an AI-drafted reply to review
 *
 * After delivery (DELIVERED/AWAITING_PAYMENT):
 *   SATISFIED       → informational only, no action needed
 *   REVISION_REQUEST → job goes back to IN_PROGRESS with the feedback
 *                      attached; the Pipeline Agent re-runs Worker Agent
 *                      with that feedback, then re-QAs automatically
 *   QUESTION/OTHER  → owner notified with an AI-drafted reply to review
 *
 * This only works for jobs we emailed a proposal to (REMOTE_BOARD apply-by
 * -email, or any source where applyEmail is set) — Upwork/marketplace
 * replies still need the manual dashboard buttons.
 */
export async function processInbox() {
  const run = await prisma.agentRun.create({ data: { agent: "INBOX", status: "RUNNING" } });

  let processed = 0;
  try {
    const emails = await fetchNewEmails();

    for (const email of emails) {
      try {
        const job = await prisma.job.findFirst({
          where: {
            applyEmail: { equals: email.from, mode: "insensitive" },
            status: { in: [...PRE_DELIVERY_STATUSES, ...POST_DELIVERY_STATUSES] },
          },
          include: { proposal: true, deliverable: true },
          orderBy: { createdAt: "desc" },
        });
        if (!job) continue; // Not a reply to anything we sent — ignore.

        if (POST_DELIVERY_STATUSES.includes(job.status)) {
          await handlePostDeliveryReply(job, email);
        } else {
          await handlePreDeliveryReply(job, email);
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

async function handlePreDeliveryReply(job, email) {
  const verdict = await askClaude(
    PRE_DELIVERY_PROMPT,
    `Original job: ${job.title}\n${job.description.slice(0, 1000)}\n\nOur proposed rate: ${job.proposal?.proposedRate ?? "n/a"}\n\nClient's reply:\nSubject: ${email.subject}\n${email.text}`,
    400,
    { agent: "INBOX", jobId: job.id },
    { model: MODELS.CLASSIFY }
  );
  const [intentLine, detailLine] = verdict.trim().split("\n");
  const intent = (intentLine || "").trim().toUpperCase();
  const detail = (detailLine || "").trim();

  if (intent === "ACCEPTED") {
    await recordProposalOutcome(job.id, "ACCEPTED");
    await notifyOwner(`Job accepted: ${job.title}`, `Client accepted. Contract/Worker/Delivery/Invoice will run automatically.`);
  } else if (intent === "REJECTED") {
    await recordProposalOutcome(job.id, "REJECTED");
    // Informational only — no action needed, this is exactly what
    // "self-healing" should look like for a normal business outcome.
  } else if (intent === "COUNTER_OFFER") {
    const ourRate = extractRate(job.proposal?.proposedRate);
    const counteredRate = extractRate(detail);
    const withinBand =
      ourRate != null && counteredRate != null && counteredRate >= ourRate * (1 - ACCEPTABLE_COUNTER_BAND);

    if (withinBand) {
      // Close the deal now rather than waiting on a human for a counter
      // that's clearly acceptable — speed of close is worth more here
      // than squeezing the last bit of rate.
      await prisma.proposal.update({
        where: { jobId: job.id },
        data: {
          proposedRate: detail,
          outcome: "ACCEPTED",
          outcomeAt: new Date(),
          negotiationLog: `Auto-accepted client counter of "${detail}" — within ${ACCEPTABLE_COUNTER_BAND * 100}% of our original ask (${job.proposal?.proposedRate}).`,
        },
      });
      await prisma.job.update({ where: { id: job.id }, data: { status: "ACCEPTED" } });
      if (job.applyEmail) {
        await sendProposalEmail({
          to: job.applyEmail,
          subject: `Re: ${job.title}`,
          text: `Thanks for the reply — ${detail} works for me. Happy to get started right away.`,
        });
      }
      await notifyOwner(
        `Auto-accepted counter-offer: ${job.title}`,
        `Client countered at "${detail}" (our ask was ${job.proposal?.proposedRate}) — within the acceptable band, so it was auto-accepted and confirmed with the client. Contract/Worker/Delivery/Invoice will run automatically.`
      );
    } else {
      await prisma.proposal.update({
        where: { jobId: job.id },
        data: { outcome: "COUNTER_OFFER", outcomeAt: new Date(), negotiationLog: `Client countered: ${detail}` },
      });
      await notifyOwner(
        `Counter-offer: ${job.title}`,
        `Client countered at "${detail}" (our proposed rate was ${job.proposal?.proposedRate ?? "n/a"}) — outside the auto-accept band. Needs your decision — open the dashboard to accept, counter again, or decline.`
      );
    }
  } else {
    await notifyOwner(
      `Client question: ${job.title}`,
      `Client wrote:\n${email.text}\n\n${intent === "QUESTION" ? `Suggested reply (not sent — review first):\n${detail}` : "Could not confidently classify this reply — please review it directly."}`
    );
  }
}

async function handlePostDeliveryReply(job, email) {
  const verdict = await askClaude(
    POST_DELIVERY_PROMPT,
    `Project: ${job.title}\n${job.description.slice(0, 1000)}\n\nClient's reply:\nSubject: ${email.subject}\n${email.text}`,
    400,
    { agent: "INBOX", jobId: job.id },
    { model: MODELS.CLASSIFY }
  );
  const [intentLine, detailLine] = verdict.trim().split("\n");
  const intent = (intentLine || "").trim().toUpperCase();
  const detail = (detailLine || "").trim();

  if (intent === "REVISION_REQUEST") {
    if (!job.deliverable) return; // nothing to revise against — fall through silently
    const nextCount = (job.deliverable.revisionCount || 0) + 1;

    if (nextCount > REVISION_FREE_ROUNDS) {
      // Don't auto-loop a client we may never satisfy — stop and let the
      // owner decide (refund the deposit, negotiate a paid extra round,
      // or walk away) rather than Worker Agent quietly doing unlimited
      // free work.
      await recordIncident({
        source: "REVISION_LIMIT",
        jobId: job.id,
        message: `Client requested a ${nextCount}th revision on "${job.title}" (${REVISION_FREE_ROUNDS} free rounds already used): "${detail}". Needs a decision — refund, paid extra round, or decline further changes.`,
        maxRetries: 0,
      });
      return;
    }

    await prisma.deliverable.update({
      where: { jobId: job.id },
      data: { needsRevision: true, qaPassed: false, revisionNotes: detail, revisionCount: nextCount },
    });
    await prisma.job.update({ where: { id: job.id }, data: { status: "IN_PROGRESS" } });
    await notifyOwner(
      `Revision requested: ${job.title}`,
      `Client asked for: "${detail}" (revision ${nextCount} of ${REVISION_FREE_ROUNDS} free). Worker Agent will revise and re-QA automatically on the next pipeline sweep.`
    );
  } else if (intent === "SATISFIED") {
    // Informational only — nothing to do, this is the good outcome.
  } else {
    await notifyOwner(
      `Client reply after delivery: ${job.title}`,
      `Client wrote:\n${email.text}\n\n${intent === "QUESTION" ? `Suggested reply (not sent — review first):\n${detail}` : "Could not confidently classify this reply — please review it directly."}`
    );
  }
}
