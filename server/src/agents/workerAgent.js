import { prisma } from "../db/client.js";
import { askClaude } from "../services/claude.js";
import { recordIncident, registerRetryHandler } from "../services/incidents.js";

/**
 * One system prompt per category we can actually deliver — this list is
 * the single source of truth for Worker Agent's scope, matching the
 * Feasibility Agent's CAPABILITY_STATEMENT. A category with no prompt
 * here routes to manual fulfillment (see pipelineAgent.js) rather than
 * being silently attempted.
 */
const SYSTEM_PROMPTS = {
  content: `You are a professional freelance content writer completing a paid job.
Produce the final deliverable exactly to the brief: correct length, tone, and format.
Do not add meta-commentary about being an AI. Output only the deliverable content.`,

  data: `You are a professional freelance researcher/data analyst completing a paid job.
Produce the final deliverable exactly to the brief: gather, structure, and summarize the
requested information clearly (use tables/lists where that fits the brief). If the brief
asks for data you cannot access directly (e.g. a live database, a paywalled source), say
exactly what's missing and provide your best structured attempt with the information given
— never fabricate specific numbers, names, or sources you weren't given or don't know.
Do not add meta-commentary about being an AI. Output only the deliverable content.`,
};

export const SUPPORTED_CATEGORIES = Object.keys(SYSTEM_PROMPTS);

/**
 * Worker Agent — dispatches to the category-appropriate prompt above.
 * Categories without one here are outside current scope and route to
 * manual fulfillment instead of being attempted.
 */
export async function runWorkerAgent(jobId) {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId }, include: { deliverable: true } });

  const systemPrompt = SYSTEM_PROMPTS[job.category];
  if (!systemPrompt) {
    throw new Error(
      `Worker agent has no prompt for category "${job.category}" on job ${jobId}. Route to manual fulfillment.`
    );
  }

  const run = await prisma.agentRun.create({
    data: { agent: "WORKER", jobId, status: "RUNNING" },
  });

  try {
    // A revision (either a failed QA pass or a client's post-delivery
    // request — see needsRevision in schema.prisma) means this isn't a
    // cold generation: feed the specific feedback back in so the rewrite
    // actually addresses it instead of independently regenerating and
    // possibly repeating the same mistake.
    const revisionContext = job.deliverable?.needsRevision
      ? `\n\nThis is a REVISION of a previous attempt. Address this feedback specifically:\n${
          job.deliverable.revisionNotes || job.deliverable.qaFeedback || "(no specific feedback given)"
        }\n\nPrevious attempt:\n${job.deliverable.content}`
      : "";

    const content = await askClaude(
      systemPrompt,
      `Client brief:\n${job.description}${revisionContext}`,
      2048,
      { agent: "WORKER", jobId }
    );

    const deliverable = await prisma.deliverable.upsert({
      where: { jobId },
      create: { jobId, content },
      update: { content, needsRevision: false },
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
