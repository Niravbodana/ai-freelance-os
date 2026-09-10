import { prisma } from "../db/client.js";
import { checkFeasibility } from "./feasibilityAgent.js";
import { draftProposal } from "./proposalAgent.js";

/**
 * Hunter Agent — discovers new jobs from pluggable sources.
 * Each source adapter must return an array of { title, description, budget, category, externalUrl, source }.
 * Real scraping/API integration for Upwork and outreach lead lists plugs in here.
 */

const sourceAdapters = [];

export function registerJobSource(adapterFn) {
  sourceAdapters.push(adapterFn);
}

// Placeholder adapter: manual/outreach leads entered via the dashboard land in
// the DB directly with status DISCOVERED, so no polling needed for those.
// Upwork has no public bidding API — this adapter is where an RSS/search-result
// parser (or a reviewed browser-automation job) would be wired in.
registerJobSource(async function upworkStub() {
  return [];
});

export async function runHunterAgent() {
  const run = await prisma.agentRun.create({
    data: { agent: "HUNTER", status: "RUNNING" },
  });

  let discovered = 0;
  try {
    for (const adapter of sourceAdapters) {
      const jobs = await adapter();
      for (const job of jobs) {
        const exists = job.externalUrl
          ? await prisma.job.findFirst({ where: { externalUrl: job.externalUrl } })
          : null;
        if (exists) continue;

        const created = await prisma.job.create({
          data: {
            source: job.source,
            externalUrl: job.externalUrl,
            title: job.title,
            description: job.description,
            budget: job.budget,
            category: job.category,
            status: "DISCOVERED",
          },
        });
        discovered += 1;

        // Every newly discovered job is gated by feasibility before a
        // proposal is ever drafted — "if we can deliver it, take it; if not,
        // skip it" is enforced here, not left to a human to remember.
        const { feasible } = await checkFeasibility(created.id);
        if (feasible) {
          await draftProposal(created.id);
        }
      }
    }

    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "SUCCESS", log: `Discovered ${discovered} jobs`, finishedAt: new Date() },
    });
  } catch (err) {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "FAILED", log: String(err), finishedAt: new Date() },
    });
    throw err;
  }

  return { discovered };
}
