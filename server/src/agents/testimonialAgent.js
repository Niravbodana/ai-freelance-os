import { prisma } from "../db/client.js";
import { askClaude } from "../services/claude.js";
import { sendProposalEmail } from "../services/notify.js";
import { recordIncident, registerRetryHandler } from "../services/incidents.js";

const DRAFT_PROMPT = `Write a short, warm, professional email (under 100 words) to a client whose
project we just completed and who just paid. Thank them briefly, then ask — low-pressure, one
sentence — whether they'd be willing to leave a short testimonial/review, and mention it helps a
small independent operation a lot. No emojis. Sign off simply, no placeholder name.`;

/**
 * Testimonial Agent — the reputation flywheel. Every paid job is a data
 * point the Proposal Agent's performance loop can't see (a good outcome,
 * not just an accepted rate) — a testimonial compounds into future win
 * rate the same way portfolio/reviews do on any marketplace. Fires once
 * per payment (testimonialRequestedAt guards against duplicates) and only
 * when we have a client email to reach; failure here never blocks
 * markPaid itself.
 */
export async function requestTestimonial(jobId) {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId }, include: { payment: true } });
  const payment = job.payment;

  if (!payment || payment.testimonialRequestedAt) return { sent: false, reason: "already requested or no payment" };

  const clientEmail = payment.clientEmail || job.applyEmail;
  if (!clientEmail) return { sent: false, reason: "no client email on file" };

  const run = await prisma.agentRun.create({ data: { agent: "TESTIMONIAL", jobId, status: "RUNNING" } });

  try {
    // Client-facing tone matters here — stays on the default (Sonnet 5)
    // generation tier rather than the classification tier.
    const draft = await askClaude(DRAFT_PROMPT, `Project: ${job.title}\nCategory: ${job.category}`, 300, {
      agent: "TESTIMONIAL",
      jobId,
    });

    await sendProposalEmail({ to: clientEmail, subject: `Thank you — ${job.title}`, text: draft });
    await prisma.payment.update({ where: { jobId }, data: { testimonialRequestedAt: new Date() } });

    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "SUCCESS", finishedAt: new Date() } });
    return { sent: true };
  } catch (err) {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "FAILED", log: String(err), finishedAt: new Date() },
    });
    await recordIncident({ source: "TESTIMONIAL", jobId, message: err.message || err, stack: err.stack });
    throw err;
  }
}

registerRetryHandler("TESTIMONIAL", requestTestimonial);
