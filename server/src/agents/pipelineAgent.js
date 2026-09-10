import { prisma } from "../db/client.js";
import { runWorkerAgent } from "./workerAgent.js";
import { runDeliveryAgent } from "./deliveryAgent.js";
import { invoiceJob } from "./paymentAgent.js";
import { recordIncident } from "../services/incidents.js";

/**
 * The self-driving state machine: once a job is ACCEPTED, nothing further
 * needs a human. This sweep finds jobs sitting at each stage and pushes
 * them to the next one — Worker → Delivery/QA → Invoice — on its own
 * schedule (scheduler.js), independent of whatever triggered the ACCEPTED
 * status (Inbox Agent auto-detection, or a manual "mark accepted" tap).
 * Each called agent already records its own Incident/retry on failure, so
 * this loop just needs to keep moving and never let one job's failure
 * block the rest of the batch.
 */
export async function advancePipeline() {
  let workerRuns = 0;
  let deliveryRuns = 0;
  let invoiceRuns = 0;

  // Worker Agent's MVP scope is "content" only (see workerAgent.js) — filter
  // here rather than let it throw every 10 minutes forever for categories
  // it was never meant to handle.
  const toWork = await prisma.job.findMany({
    where: { status: "ACCEPTED", deliverable: null, category: "content" },
  });
  for (const job of toWork) {
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
    where: { status: "ACCEPTED", deliverable: null, category: { not: "content" } },
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

  const toDeliver = await prisma.job.findMany({
    where: { status: "IN_PROGRESS" },
    include: { deliverable: true },
  });
  for (const job of toDeliver) {
    if (!job.deliverable || job.deliverable.qaPassed) continue;
    try {
      await runDeliveryAgent(job.id);
      deliveryRuns += 1;
    } catch (err) {
      console.error(`[pipeline] delivery failed for job ${job.id} (incident recorded, will retry):`, err.message);
    }
  }

  const toInvoice = await prisma.job.findMany({
    where: { status: "DELIVERED", payment: null },
  });
  for (const job of toInvoice) {
    try {
      await invoiceJob(job.id, { clientEmail: job.applyEmail || undefined });
      invoiceRuns += 1;
    } catch (err) {
      console.error(`[pipeline] invoice failed for job ${job.id} (incident recorded, will retry):`, err.message);
    }
  }

  return { workerRuns, deliveryRuns, invoiceRuns };
}
