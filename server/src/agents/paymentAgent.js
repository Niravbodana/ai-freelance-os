import { prisma } from "../db/client.js";
import { pickProvider, createInvoiceLink } from "../services/payments.js";
import { notifications, sendProposalEmail } from "../services/notify.js";
import { recordIncident, registerRetryHandler } from "../services/incidents.js";
import { requestTestimonial } from "./testimonialAgent.js";
import { askClaude } from "../services/claude.js";

const REMINDER_INTERVAL_DAYS = 3;
const DUE_IN_DAYS = 7;
// 50% read as too aggressive for a new, unproven operation — a stranger
// asked to pay half a project's cost upfront to a business with no track
// record hurts conversion more than it protects revenue. 30% is real
// protection (a no-show client still costs us nothing, since Worker Agent
// never starts without it) without being the thing that makes them walk
// away. See pipelineAgent.js's isRisky() for the size-based exemption
// that skips this entirely for small jobs.
const DEPOSIT_FRACTION = 0.3;

export function parseRate(rateStr) {
  const match = String(rateStr ?? "").match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

/**
 * Payment Agent — invoices a job, then a scheduled sweep (see
 * scheduler.js) chases unpaid invoices automatically. Nothing here marks
 * a job PAID by itself — that only happens via a provider webhook or a
 * manual confirm, so we never falsely tell a client "paid" state.
 *
 * A job can carry up to two payments: DEPOSIT (only for first-time
 * non-recurring OUTREACH/MANUAL clients — see pipelineAgent.js's deposit
 * gate) and FINAL (everyone else's only payment, or the remaining
 * balance after a paid deposit). `kind` defaults to FINAL so every
 * existing call site keeps working unchanged.
 */
export async function invoiceJob(jobId, { amount, currency = "USD", clientEmail, kind = "FINAL" } = {}) {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId }, include: { proposal: true, payments: true } });

  const run = await prisma.agentRun.create({ data: { agent: "PAYMENT", jobId, status: "RUNNING" } });

  try {
    const fullRate = parseRate(job.proposal?.proposedRate);
    let finalAmount = amount;
    if (finalAmount == null) {
      if (!fullRate) throw new Error("No amount available to invoice — pass amount or ensure proposal has a rate");
      if (kind === "DEPOSIT") {
        finalAmount = Math.round(fullRate * DEPOSIT_FRACTION * 100) / 100;
      } else {
        const paidDeposit = job.payments.find((p) => p.kind === "DEPOSIT" && p.status === "PAID");
        finalAmount = paidDeposit ? Math.round((fullRate - paidDeposit.amount) * 100) / 100 : fullRate;
      }
    }
    if (!finalAmount || finalAmount <= 0) throw new Error(`Computed invoice amount is invalid (${finalAmount}) for kind ${kind}`);

    const provider = pickProvider(currency);
    const invoiceUrl = await createInvoiceLink({
      provider,
      amount: finalAmount,
      currency,
      description: kind === "DEPOSIT" ? `${job.title} — deposit` : job.title,
      clientEmail,
    });

    const dueDate = new Date(Date.now() + DUE_IN_DAYS * 24 * 60 * 60 * 1000);
    const resolvedClientEmail = clientEmail || job.applyEmail || null;

    const payment = await prisma.payment.upsert({
      where: { jobId_kind: { jobId, kind } },
      create: {
        jobId,
        kind,
        provider,
        amount: finalAmount,
        currency,
        invoiceUrl,
        dueDate,
        status: "INVOICE_SENT",
        clientEmail: resolvedClientEmail,
      },
      update: { provider, amount: finalAmount, currency, invoiceUrl, dueDate, status: "INVOICE_SENT", clientEmail: resolvedClientEmail },
    });

    // Only a FINAL invoice means "delivered, now collecting" — a deposit
    // invoice happens before any work starts, so the job stays ACCEPTED
    // (AWAITING_PAYMENT is reserved for the post-delivery meaning
    // everywhere else in this app: JobCard, the status page, stats).
    if (kind === "FINAL") {
      await prisma.job.update({ where: { id: jobId }, data: { status: "AWAITING_PAYMENT" } });
    }

    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "SUCCESS", finishedAt: new Date() } });
    return payment;
  } catch (err) {
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "FAILED", log: String(err), finishedAt: new Date() } });
    // Two incident sources (not one) so the incident retry sweep calls
    // back in with the right kind — see registerRetryHandler below.
    await recordIncident({
      source: kind === "DEPOSIT" ? "PAYMENT_DEPOSIT" : "PAYMENT_FINAL",
      jobId,
      message: err.message || err,
      stack: err.stack,
    });
    throw err;
  }
}

registerRetryHandler("PAYMENT_DEPOSIT", (jobId) => invoiceJob(jobId, { kind: "DEPOSIT" }));
registerRetryHandler("PAYMENT_FINAL", (jobId) => invoiceJob(jobId, { kind: "FINAL" }));

export async function markPaid(jobId, kind = "FINAL") {
  await prisma.payment.update({ where: { jobId_kind: { jobId, kind } }, data: { status: "PAID", paidAt: new Date() } });

  // A deposit being paid unblocks Worker Agent (see pipelineAgent.js) but
  // isn't project completion — only a FINAL payment triggers the
  // recurring-client count and the testimonial request.
  if (kind !== "FINAL") return;

  await prisma.job.update({ where: { id: jobId }, data: { status: "PAID" } });

  // A client who pays without friction is exactly who a recurring-client
  // program should flag — count their completed jobs and mark recurring.
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (job?.clientId) {
    const client = await prisma.client.findUnique({ where: { id: job.clientId } });
    const paidCount = await prisma.job.count({ where: { clientId: job.clientId, status: "PAID" } });
    if (paidCount >= 2 && client && !client.isRecurring) {
      await prisma.client.update({ where: { id: job.clientId }, data: { isRecurring: true } });
      // The single highest-leverage thing this system can do for revenue:
      // a client who's paid twice without friction is worth far more as a
      // standing monthly retainer than as another one-off job — pitching
      // one now needs zero new hunting. Fire-and-forget, same as the
      // testimonial request below; a failure here must never block payment
      // confirmation itself.
      pitchRetainer(job.clientId, job.category).catch((err) =>
        console.error(`[payment] retainer pitch failed for client ${job.clientId}:`, err.message)
      );
    }
  }

  // Fire-and-forget: a testimonial request failing must never break the
  // payment confirmation itself. requestTestimonial records its own
  // Incident and is retry-registered, so a transient failure heals itself.
  requestTestimonial(jobId).catch((err) => console.error(`[payment] testimonial request failed for ${jobId}:`, err.message));
}

const RETAINER_PROMPT = `Write a short, warm, low-pressure email (under 130 words) to a client we've
now completed two paid projects for. Thank them briefly for being a repeat client, then pitch a
simple monthly retainer package in their line of work — a fixed number of deliverables per month
at a modest bundled discount versus paying per-project — as a way to skip the back-and-forth of
re-briefing and re-invoicing each time. Propose one concrete example package (e.g. "4 pieces/month")
with an approximate price range appropriate to the category, but make clear it's flexible and open
to their actual needs. End with a simple, no-pressure question inviting a reply if interested. No
emojis. Sign off simply, no placeholder name.`;

/**
 * Pitches a standing monthly retainer to a client who's just proven
 * themselves reliable (two paid jobs, no friction) — the single highest-
 * leverage revenue move available: turning one relationship into recurring
 * income costs nothing further in Hunter Agent discovery or Feasibility
 * calls. Fires once per client (retainerPitchedAt guards it) and only when
 * there's an email on file.
 */
export async function pitchRetainer(clientId, categoryHint) {
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
  if (client.retainerPitchedAt) return { sent: false, reason: "already pitched" };
  if (!client.email) return { sent: false, reason: "no client email on file" };

  const run = await prisma.agentRun.create({ data: { agent: "RETAINER", status: "RUNNING" } });

  try {
    const draft = await askClaude(
      RETAINER_PROMPT,
      `Client: ${client.name}\nWork category: ${categoryHint || "general freelance work"}`,
      350,
      { agent: "RETAINER" }
    );

    await sendProposalEmail({ to: client.email, subject: "A standing arrangement?", text: draft });
    await prisma.client.update({ where: { id: clientId }, data: { retainerPitchedAt: new Date() } });

    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "SUCCESS", finishedAt: new Date() } });
    return { sent: true };
  } catch (err) {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "FAILED", log: String(err), finishedAt: new Date() },
    });
    // Unlike every other incident source here, this one isn't keyed to a
    // jobId — it's a one-off marketing action on a client, not a pipeline
    // step blocking a job. The generic retry sweep only looks up a handler
    // when an incident carries a jobId, so this would never actually get
    // retried automatically; maxRetries: 0 makes that explicit and
    // escalates straight to the owner instead of sitting as a silently
    // dead "OPEN" incident forever.
    await recordIncident({ source: "RETAINER", message: err.message || err, stack: err.stack, maxRetries: 0 });
    throw err;
  }
}

/**
 * Runs on a schedule: any AWAITING_PAYMENT invoice (deposit or final) past
 * its due date gets a reminder sent (rate-limited by
 * REMINDER_INTERVAL_DAYS) and the owner is notified so a stuck payment
 * never just sits silently.
 */
export async function sweepOverduePayments() {
  const overdue = await prisma.payment.findMany({
    where: { status: "INVOICE_SENT", dueDate: { lt: new Date() } },
    include: { job: true },
  });

  for (const payment of overdue) {
    const dueForReminder =
      !payment.lastReminderAt ||
      Date.now() - payment.lastReminderAt.getTime() > REMINDER_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
    if (!dueForReminder) continue;

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "OVERDUE", lastReminderAt: new Date(), reminderCount: { increment: 1 } },
    });
    await notifications.paymentOverdue(payment.job, payment);
    // A real reminder email/message to the CLIENT (not just the owner) goes
    // here once a client contact channel is wired in per job/client.
  }

  return { checked: overdue.length };
}
