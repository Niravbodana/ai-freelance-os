import nodemailer from "nodemailer";

/**
 * Sends every "you need to look at this" event to the owner's email, so
 * approvals, new feasible jobs, and payment problems reach the phone even
 * when nobody is watching the dashboard. One transporter, reused.
 */
let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

export async function notifyOwner(subject, text) {
  const t = getTransporter();
  const to = process.env.OWNER_EMAIL;
  if (!t || !to) {
    console.log(`[notify] (SMTP not configured, logging only) ${subject}: ${text}`);
    return;
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
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
  await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
  return { sent: true };
}

export const notifications = {
  approvalNeeded: (job) =>
    notifyOwner(
      `Proposal needs your approval: ${job.title}`,
      `A proposal for "${job.title}" (${job.source}) is waiting for your approval before it's sent.\nOpen the dashboard to review and approve.`
    ),
  jobNotFeasible: (job, note) =>
    notifyOwner(`Skipped (not feasible): ${job.title}`, `Reason: ${note}`),
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
  agentFailed: (agentName, jobTitle, err) =>
    notifyOwner(`Agent error: ${agentName}`, `Job: ${jobTitle ?? "n/a"}\nError: ${err}`),
};
