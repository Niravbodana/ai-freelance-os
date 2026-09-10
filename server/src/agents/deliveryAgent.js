import { prisma } from "../db/client.js";
import { askClaude, MODELS } from "../services/claude.js";
import { notifications } from "../services/notify.js";
import { recordIncident, registerRetryHandler } from "../services/incidents.js";

const QA_SYSTEM_PROMPT = `You are a strict QA reviewer for freelance deliverables.
Compare the deliverable against the client brief. Reply with exactly one word,
"PASS" or "FAIL", followed by a newline and a one-sentence reason.`;

/**
 * Delivery Agent — runs a QA pass against the original brief before marking
 * a job ready to send back to the client. A FAIL keeps the job IN_PROGRESS
 * for a retry or human fix rather than shipping bad work.
 */
export async function runDeliveryAgent(jobId) {
  const job = await prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    include: { deliverable: true },
  });

  if (!job.deliverable) {
    throw new Error(`Job ${jobId} has no deliverable to QA yet`);
  }

  const run = await prisma.agentRun.create({
    data: { agent: "DELIVERY", jobId, status: "RUNNING" },
  });

  try {
    const verdict = await askClaude(
      QA_SYSTEM_PROMPT,
      `Client brief:\n${job.description}\n\nDeliverable:\n${job.deliverable.content}`,
      100,
      { agent: "DELIVERY", jobId },
      { model: MODELS.CLASSIFY }
    );
    const qaPassed = verdict.trim().toUpperCase().startsWith("PASS");

    await prisma.deliverable.update({
      where: { jobId },
      data: {
        qaPassed,
        deliveredAt: qaPassed ? new Date() : null,
        // A fail needs Worker Agent to actually revise before QA re-checks
        // — see needsRevision's doc comment in schema.prisma for why this
        // gate exists (it used to loop QA on unchanged content forever).
        needsRevision: !qaPassed,
        qaFeedback: qaPassed ? null : verdict,
      },
    });

    await prisma.job.update({
      where: { id: jobId },
      data: { status: qaPassed ? "DELIVERED" : "IN_PROGRESS" },
    });

    if (!qaPassed) {
      await notifications.deliveryQaFailed(job, verdict);
    }

    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "SUCCESS", log: verdict, finishedAt: new Date() },
    });

    return { qaPassed, verdict };
  } catch (err) {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "FAILED", log: String(err), finishedAt: new Date() },
    });
    await recordIncident({ source: "DELIVERY", jobId, message: err.message || err, stack: err.stack });
    throw err;
  }
}

registerRetryHandler("DELIVERY", runDeliveryAgent);
