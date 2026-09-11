import nodemailer from "nodemailer";
import { getConfig } from "./config.js";

/**
 * Sends every "you need to look at this" event to the owner's email, so
 * approvals, new feasible jobs, and payment problems reach the phone even
 * when nobody is watching the dashboard. Built fresh per call (not cached)
 * since SMTP settings can change at runtime via Admin Settings — nodemailer
 * transport creation is cheap, no network call happens until send/verify.
 */
function getTransporter() {
  const host = getConfig("SMTP_HOST");
  if (!host) return null;
  return nodemailer.createTransport({
    host,
    port: Number(getConfig("SMTP_PORT") || 587),
    secure: getConfig("SMTP_SECURE") === "true",
    auth: { user: getConfig("SMTP_USER"), pass: getConfig("SMTP_PASS") },
  });
}

export async function notifyOwner(subject, text) {
  const t = getTransporter();
  const to = getConfig("OWNER_EMAIL");
  if (!t || !to) {
    console.log(`[notify] (SMTP not configured, logging only) ${subject}: ${text}`);
    return;
  }
  await t.sendMail({
    from: getConfig("SMTP_FROM") || getConfig("SMTP_USER"),
    to,
    subject: `[AI Freelance OS] ${subject}`,
    text,
  });
}

/**
 * Sends the actual proposal to a client's application email — used only for
 * job posts that explicitly published an "apply by email" address (they
 * invited applications; this is a normal job application, not cold spam).
 */
export async function sendProposalEmail({ to, subject, text }) {
  const t = getTransporter();
  if (!t) {
    console.log(`[notify] (SMTP not configured, would send to ${to}) ${subject}`);
    return { sent: false };
  }
  await t.sendMail({ from: getConfig("SMTP_FROM") || getConfig("SMTP_USER"), to, subject, text });
  return { sent: true };
}

export const notifications = {
  approvalNeeded: (job) =>
    notifyOwner(
      `Proposal needs your approval: ${job.title}`,
      `A proposal for "${job.title}" (${job.source}) is waiting for your approval before it's sent.\nOpen the dashboard to review and approve.`
    ),
  // Not-feasible jobs are the normal, expected outcome of the feasibility
  // gate doing its job — there's nothing for the owner to act on, so this
  // stays a log line only. Emailing one per rejected job (dozens per Hunter
  // run, mostly full-time postings from general job boards) was pure noise.
  jobNotFeasible: (job, note) => console.log(`[notify] (not feasible, no email) ${job.title}: ${note}`),
  autoSent: (job) =>
    notifyOwner(
      `Proposal auto-sent: ${job.title}`,
      `Outreach proposal for "${job.title}" was drafted and sent automatically (no marketplace ToS restriction on this channel).`
    ),
  deliveryQaFailed: (job, verdict) =>
    notifyOwner(`QA FAILED on delivery: ${job.title}`, `QA verdict: ${verdict}\nJob kept IN_PROGRESS for a retry/manual fix.`),
  paymentOverdue: (job, payment) =>
    notifyOwner(
      `Payment overdue: ${job.title}`,
      `Invoice for "${job.title}" (${payment.amount} ${payment.currency}) is overdue. Reminder #${payment.reminderCount + 1} sent to client.`
    ),
};
