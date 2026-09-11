import { prisma } from "../db/client.js";
import { runWorkerAgent, SUPPORTED_CATEGORIES } from "./workerAgent.js";
import { runDeliveryAgent } from "./deliveryAgent.js";
import { invoiceJob } from "./paymentAgent.js";
import { sendContract } from "./contractAgent.js";
import { recordIncident } from "../services/incidents.js";

const NEW_CLIENT_RISK_SOURCES = new Set(["OUTREACH", "MANUAL"]);

function isRisky(job) {
  return NEW_CLIENT_RISK_SOURCES.has(job.source) && !job.client?.isRecurring;
}

/**
 * The self-driving state machine: once a job is ACCEPTED, nothing further
 * needs a human. This sweep finds jobs sitting at each stage and pushes
 * them to the next one — Contract → Deposit (if required) → Worker →
 * Delivery/QA → Final Invoice — on its own schedule (scheduler.js),
 * independent of whatever triggered the ACCEPTED status (Inbox Agent
 * auto-detection, or a manual "mark accepted" tap). Each called agent
 * already records its own Incident/retry on failure, so this loop just
 * needs to keep moving and never let one job's failure block the rest of
 * the batch.
 */
export async function advancePipeline() {
  let workerRuns = 0;
  let deliveryRuns = 0;
  let invoiceRuns = 0;
  let depositInvoiceRuns = 0;
  let contractsSent = 0;

  // Sources without a platform-level agreement (Upwork/Freelancer/Guru all
  // have their own terms of service covering the engagement) get a simple
  // service agreement emailed automatically — a paper trail that protects
  // both sides if a payment dispute ever comes up. Fires once per job
  // (contractSentAt guards it) and never blocks the rest of the pipeline.
  const toContract = await prisma.job.findMany({
    where: { status: "ACCEPTED", contractSentAt: null, source: { in: [...NEW_CLIENT_RISK_SOURCES] } },
  });
  for (const job of toContract) {
    try {
      const result = await sendContract(job.id);
      if (result.sent) contractsSent += 1;
    } catch (err) {
      console.error(`[pipeline] contract send failed for job ${job.id} (incident recorded, will retry):`, err.message);
    }
  }

  // The deposit gate: a first-time (non-recurring) outreach/manual client
  // has no track record and no platform escrow behind them. Rather than
  // silently doing full unpaid work for a stranger, or just leaving an
  // advisory note, this invoices a real DEPOSIT and Worker Agent is held
  // back (see the isRisky() filter below) until it's actually PAID.
  const acceptedCandidates = await prisma.job.findMany({
    where: { status: "ACCEPTED", deliverable: null, category: { in: SUPPORTED_CATEGORIES } },
    include: { client: true, payments: true, proposal: true },
  });

  for (const job of acceptedCandidates) {
    if (!isRisky(job)) continue;
    const deposit = job.payments.find((p) => p.kind === "DEPOSIT");
    if (deposit) continue; // already invoiced (or paid) — nothing more to do here
    try {
      await invoiceJob(job.id, { kind: "DEPOSIT", clientEmail: job.applyEmail || undefined });
      depositInvoiceRuns += 1;
    } catch (err) {
      console.error(`[pipeline] deposit invoice failed for job ${job.id} (incident recorded, will retry):`, err.message);
    }
  }

  // Worker Agent's scope is whatever categories have a prompt in
  // workerAgent.js (currently content + data). A risky job only qualifies
  // once its deposit is PAID; a trusted job (platform-sourced, or a
  // recurring client) never needed one. Also picks up revisions
  // (needsRevision=true on an existing deliverable) — see workerAgent.js
  // for how it uses the stored feedback instead of blindly regenerating.
  const freshWork = acceptedCandidates.filter((job) => {
    if (!isRisky(job)) return true;
    const deposit = job.payments.find((p) => p.kind === "DEPOSIT");
    return deposit?.status === "PAID";
  });
  const revisionWork = await prisma.job.findMany({
    where: { category: { in: SUPPORTED_CATEGORIES }, status: "IN_PROGRESS", deliverable: { needsRevision: true } },
  });
  for (const job of [...freshWork, ...revisionWork]) {
    try {
      await runWorkerAgent(job.id);
      workerRuns += 1;
    } catch (err) {
      console.error(`[pipeline] worker failed for job ${job.id} (incident recorded, will retry):`, err.message);
    }
  }

  // Accepted jobs outside Worker Agent's scope need a human to fulfill —
  // flag each one exactly once (maxRetries: 0 skips the pointless retry
  // loop and escalates straight to the owner on the next incident sweep).
  const needsManualWork = await prisma.job.findMany({
    where: { status: "ACCEPTED", deliverable: null, category: { notIn: SUPPORTED_CATEGORIES } },
  });
  for (const job of needsManualWork) {
    const alreadyFlagged = await prisma.incident.findFirst({
      where: { source: "PIPELINE_MANUAL_ROUTE", jobId: job.id, status: { in: ["OPEN", "ESCALATED"] } },
    });
    if (alreadyFlagged) continue;
    await recordIncident({
      source: "PIPELINE_MANUAL_ROUTE",
      jobId: job.id,
      message: `Job "${job.title}" (category "${job.category}") was accepted but is outside Worker Agent's scope — needs manual fulfillment.`,
      maxRetries: 0,
    });
  }

  // Only re-run QA once a revision has actually happened (needsRevision
  // false) — otherwise this would re-check the same stale, unrevised
  // content every cycle forever instead of giving Worker Agent a turn.
  const toDeliver = await prisma.job.findMany({
    where: { status: "IN_PROGRESS" },
    include: { deliverable: true },
  });
  for (const job of toDeliver) {
    if (!job.deliverable || job.deliverable.qaPassed || job.deliverable.needsRevision) continue;
    try {
      await runDeliveryAgent(job.id);
      deliveryRuns += 1;
    } catch (err) {
      console.error(`[pipeline] delivery failed for job ${job.id} (incident recorded, will retry):`, err.message);
    }
  }

  const toInvoice = await prisma.job.findMany({
    where: { status: "DELIVERED", payments: { none: { kind: "FINAL" } } },
  });
  for (const job of toInvoice) {
    try {
      await invoiceJob(job.id, { kind: "FINAL", clientEmail: job.applyEmail || undefined });
      invoiceRuns += 1;
    } catch (err) {
      console.error(`[pipeline] invoice failed for job ${job.id} (incident recorded, will retry):`, err.message);
    }
  }

  return { workerRuns, deliveryRuns, invoiceRuns, depositInvoiceRuns, contractsSent };
}
