import { prisma } from "../db/client.js";
import { pickProvider, createInvoiceLink } from "../services/payments.js";
import { notifications } from "../services/notify.js";
import { recordIncident, registerRetryHandler } from "../services/incidents.js";

const REMINDER_INTERVAL_DAYS = 3;
const DUE_IN_DAYS = 7;

/**
 * Payment Agent — invoices a job once it's DELIVERED, then a scheduled sweep
 * (see scheduler.js) chases unpaid invoices automatically. Nothing here
 * marks a job PAID by itself — that only happens via a provider webhook or
 * a manual confirm, so we never falsely tell a client "paid" state.
 */
export async function invoiceJob(jobId, { amount, currency = "USD", clientEmail } = {}) {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId }, include: { proposal: true } });

  const run = await prisma.agentRun.create({ data: { agent: "PAYMENT", jobId, status: "RUNNING" } });

  try {
    const finalAmount = amount ?? parseFloat(job.proposal?.proposedRate?.replace(/[^0-9.]/g, "")) ?? null;
    if (!finalAmount) throw new Error("No amount available to invoice — pass amount or ensure proposal has a rate");

    const provider = pickProvider(currency);
    const invoiceUrl = await createInvoiceLink({
      provider,
      amount: finalAmount,
      currency,
      description: job.title,
      clientEmail,
    });

    const dueDate = new Date(Date.now() + DUE_IN_DAYS * 24 * 60 * 60 * 1000);

    const payment = await prisma.payment.upsert({
      where: { jobId },
      create: { jobId, provider, amount: finalAmount, currency, invoiceUrl, dueDate, status: "INVOICE_SENT" },
      update: { provider, amount: finalAmount, currency, invoiceUrl, dueDate, status: "INVOICE_SENT" },
    });

    await prisma.job.update({ where: { id: jobId }, data: { status: "AWAITING_PAYMENT" } });
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "SUCCESS", finishedAt: new Date() } });

    return payment;
  } catch (err) {
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "FAILED", log: String(err), finishedAt: new Date() } });
    await recordIncident({ source: "PAYMENT", jobId, message: err.message || err, stack: err.stack });
    throw err;
  }
}

registerRetryHandler("PAYMENT", invoiceJob);

export async function markPaid(jobId) {
  await prisma.payment.update({ where: { jobId }, data: { status: "PAID", paidAt: new Date() } });
  await prisma.job.update({ where: { id: jobId }, data: { status: "PAID" } });

  // A client who pays without friction is exactly who a recurring-client
  // program should flag — count their completed jobs and mark recurring.
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (job?.clientId) {
    const paidCount = await prisma.job.count({ where: { clientId: job.clientId, status: "PAID" } });
    if (paidCount >= 2) {
      await prisma.client.update({ where: { id: job.clientId }, data: { isRecurring: true } });
    }
  }
}

/**
 * Runs on a schedule: any AWAITING_PAYMENT invoice past its due date gets a
 * reminder sent (rate-limited by REMINDER_INTERVAL_DAYS) and the owner is
 * notified so a stuck payment never just sits silently.
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
