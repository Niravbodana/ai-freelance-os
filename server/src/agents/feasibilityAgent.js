import { prisma } from "../db/client.js";
import { askClaude } from "../services/claude.js";
import { notifications } from "../services/notify.js";
import { recordIncident, registerRetryHandler } from "../services/incidents.js";

// What the system is actually allowed to say "yes" to. This is the single
// source of truth for capability — extend it deliberately, category by
// category, not by loosening the feasibility prompt.
const CAPABILITY_STATEMENT = `We can reliably deliver:
- Content/copywriting: blog posts, articles, product descriptions, website copy
- Research and structured data summarization
We CANNOT yet reliably deliver (reject these):
- Custom software / complex coding projects
- Video editing, voice-over, audio production
- Any work requiring physical presence or real-time human interaction
- Legal, medical, or financial advice requiring professional licensing`;

const SYSTEM_PROMPT = `You are a feasibility gatekeeper for a freelance operation.
${CAPABILITY_STATEMENT}
Given a job post, reply with exactly:
Line 1: YES or NO
Line 2: one-sentence reason
Be strict — when in doubt, say NO. Taking on work we can't deliver damages the business.`;

/**
 * Feasibility Agent — runs right after a job is discovered. Only jobs marked
 * feasible move on to the Proposal Agent; everything else is marked
 * NOT_FEASIBLE and skipped, with the reason logged and notified.
 */
export async function checkFeasibility(jobId) {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });

  const run = await prisma.agentRun.create({
    data: { agent: "FEASIBILITY", jobId, status: "RUNNING" },
  });

  try {
    const verdict = await askClaude(
      SYSTEM_PROMPT,
      `Title: ${job.title}\nCategory: ${job.category}\nBudget: ${job.budget ?? "n/a"}\n\n${job.description}`,
      150,
      { agent: "FEASIBILITY", jobId }
    );
    const [firstLine, ...rest] = verdict.trim().split("\n");
    const feasible = firstLine.trim().toUpperCase().startsWith("YES");
    const note = rest.join(" ").trim() || verdict;

    await prisma.job.update({
      where: { id: jobId },
      data: {
        feasible,
        feasibilityNote: note,
        status: feasible ? "DISCOVERED" : "NOT_FEASIBLE",
      },
    });

    if (!feasible) {
      await notifications.jobNotFeasible(job, note);
    }

    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "SUCCESS", log: verdict, finishedAt: new Date() },
    });

    return { feasible, note };
  } catch (err) {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "FAILED", log: String(err), finishedAt: new Date() },
    });
    await recordIncident({ source: "FEASIBILITY", jobId, message: err.message || err, stack: err.stack });
    throw err;
  }
}

registerRetryHandler("FEASIBILITY", checkFeasibility);
