import { prisma } from "../db/client.js";
import { askClaude } from "../services/claude.js";
import { recordIncident, registerRetryHandler } from "../services/incidents.js";

const SYSTEM_PROMPT = `You are a professional freelance content writer completing a paid job.
Produce the final deliverable exactly to the brief: correct length, tone, and format.
Do not add meta-commentary about being an AI. Output only the deliverable content.`;

/**
 * Worker Agent — MVP scope is the content/copywriting category, where a
 * single-pass generation is reliably deliverable. Other categories should
 * route to a human or a category-specific worker before this is called.
 */
export async function runWorkerAgent(jobId) {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });

  if (job.category !== "content") {
    throw new Error(
      `Worker agent MVP only supports category "content"; job ${jobId} is "${job.category}". Route to manual fulfillment.`
    );
  }

  const run = await prisma.agentRun.create({
    data: { agent: "WORKER", jobId, status: "RUNNING" },
  });

  try {
    const content = await askClaude(
      SYSTEM_PROMPT,
      `Client brief:\n${job.description}`,
      2048,
      { agent: "WORKER", jobId }
    );

    const deliverable = await prisma.deliverable.upsert({
      where: { jobId },
      create: { jobId, content },
      update: { content },
    });

    await prisma.job.update({ where: { id: jobId }, data: { status: "IN_PROGRESS" } });
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "SUCCESS", finishedAt: new Date() },
    });

    return deliverable;
  } catch (err) {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "FAILED", log: String(err), finishedAt: new Date() },
    });
    await recordIncident({ source: "WORKER", jobId, message: err.message || err, stack: err.stack });
    throw err;
  }
}

registerRetryHandler("WORKER", runWorkerAgent);
