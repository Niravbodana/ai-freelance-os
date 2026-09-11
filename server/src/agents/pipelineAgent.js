import { prisma } from "../db/client.js";
import { runWorkerAgent, SUPPORTED_CATEGORIES } from "./workerAgent.js";
import { runDeliveryAgent } from "./deliveryAgent.js";
import { invoiceJob, parseRate } from "./paymentAgent.js";
import { sendContract } from "./contractAgent.js";
import { recordIncident } from "../services/incidents.js";

// Below this, the deposit gate's own protection costs more (in lost
// trust/conversion on a tiny job) than the non-payment risk it's guarding
// against — a stranger skipping out on a $30 job is a rounding error, but
// being asked for money upfront by a brand-new operation is exactly the
// kind of thing that makes them pick someone else instead. The contract
// email still goes out either way (free, no trust cost).
const DEPOSIT_EXEMPT_BELOW_USD = 50;

// UPWORK/FREELANCER/GURU carry their own platform escrow/ToS protecting
// payment — those are excluded. Everything else (our own outreach, manual
// entries, and REMOTE_BOARD job-board postings) has zero payment
// protection behind it: a job-board client can receive full work and
// simply never pay, with nothing but an email reminder as recourse. So
// REMOTE_BOARD is treated exactly like OUTREACH/MANUAL here even though
// it's platform-sourced — it's still a stranger with no track record and
// no escrow.
const NEW_CLIENT_RISK_SOURCES = new Set(["OUTREACH", "MANUAL", "REMOTE_BOARD"]);

function isRisky(job) {
  if (!NEW_CLIENT_RISK_SOURCES.has(job.source) || job.client?.isRecurring) return false;
  const rate = parseRate(job.proposal?.proposedRate);
  // No parseable rate (rare — a hand-entered MANUAL job with no rate) still
  // gets the deposit gate, since we can't confirm it's small.
  if (rate != null && rate < DEPOSIT_EXEMPT_BELOW_USD) return false;
  return true;
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

  // The deposit gate: a first-time (non-recurring) client from any
  // no-escrow source (outreach, manual, or a REMOTE_BOARD job-board
  // posting) has no track record and nothing forcing them to pay once
  // work is delivered. Rather than silently doing full unpaid work for a
  // stranger, or just leaving an advisory note, this invoices a real
  // DEPOSIT and Worker Agent is held back (see the isRisky() filter below)
  // until it's actually PAID.
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
