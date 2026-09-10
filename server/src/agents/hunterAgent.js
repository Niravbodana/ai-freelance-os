import { prisma } from "../db/client.js";
import { checkFeasibility } from "./feasibilityAgent.js";
import { draftProposal } from "./proposalAgent.js";
import {
  remoteOkAdapter,
  weWorkRemotelyAdapter,
  remotiveAdapter,
  arbeitnowAdapter,
} from "./sources/remoteJobBoards.js";
import { freelancerComAdapter } from "./sources/freelancerCom.js";
import { guruComAdapter } from "./sources/guruCom.js";

/**
 * Hunter Agent — discovers new jobs from pluggable sources.
 * Each source adapter must return an array of
 * { title, description, budget, category, externalUrl, source, applyEmail? }.
 *
 * Every adapter here is deliberately limited to sources that are either (a)
 * an official API meant for programmatic use, or (b) a public feed (RSS/JSON)
 * a site publishes specifically for aggregators/software to consume. No
 * adapter here scrapes login-walled pages, arbitrary comment sections, or
 * anything a site's own terms ask not to be automated — see README for why.
 */

const sourceAdapters = [];

export function registerJobSource(adapterFn) {
  sourceAdapters.push(adapterFn);
}

// Upwork has no public bidding API — this stays a stub. Wiring in scraping
// or unofficial automation here would violate Upwork's ToS and risk the
// account; if Upwork ever opens a partner API, it plugs in here instead.
registerJobSource(async function upworkStub() {
  return [];
});

// All four below are genuinely public, no-auth, no-approval-process APIs —
// live the moment the server starts, no credentials needed at all.
registerJobSource(remoteOkAdapter);
registerJobSource(weWorkRemotelyAdapter);
registerJobSource(remotiveAdapter);
registerJobSource(arbeitnowAdapter);
// No-ops until FREELANCER_OAUTH_TOKEN / GURU_API_KEY are configured — see
// each adapter's file for what's needed to activate it.
registerJobSource(freelancerComAdapter);
registerJobSource(guruComAdapter);

export async function runHunterAgent() {
  const run = await prisma.agentRun.create({
    data: { agent: "HUNTER", status: "RUNNING" },
  });

  let discovered = 0;
  try {
    for (const adapter of sourceAdapters) {
      let jobs = [];
      try {
        jobs = await adapter();
      } catch (adapterErr) {
        // One source being down (network blip, feed format change) shouldn't
        // stop the others from being polled this cycle.
        console.error(`[hunter] adapter ${adapter.name} failed:`, adapterErr);
        continue;
      }
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
            applyEmail: job.applyEmail ?? null,
            externalMeta: job.meta ?? undefined,
            status: "DISCOVERED",
          },
        });
        discovered += 1;

        // Every newly discovered job is gated by feasibility before a
        // proposal is ever drafted — "if we can deliver it, take it; if not,
        // skip it" is enforced here, not left to a human to remember. Each
        // job's processing is isolated: checkFeasibility/draftProposal
        // already record their own Incident and get retried by the
        // incident sweep, so one bad job must not stop the rest of this
        // batch from being processed.
        try {
          const { feasible } = await checkFeasibility(created.id);
          if (feasible) {
            await draftProposal(created.id);
          }
        } catch (jobErr) {
          console.error(`[hunter] processing job ${created.id} failed (will retry via incident sweep):`, jobErr);
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
