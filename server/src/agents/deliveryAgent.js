import { prisma } from "../db/client.js";
import { askClaude } from "../services/claude.js";

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
      100
    );
    const qaPassed = verdict.trim().toUpperCase().startsWith("PASS");

    await prisma.deliverable.update({
      where: { jobId },
      data: { qaPassed, deliveredAt: qaPassed ? new Date() : null },
    });

    await prisma.job.update({
      where: { id: jobId },
      data: { status: qaPassed ? "DELIVERED" : "IN_PROGRESS" },
    });

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
    throw err;
  }
}
