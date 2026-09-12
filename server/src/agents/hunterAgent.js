import crypto from "node:crypto";
import { prisma } from "../db/client.js";
import { checkFeasibility } from "./feasibilityAgent.js";
import { draftProposal } from "./proposalAgent.js";
import {
  remoteOkAdapter,
  weWorkRemotelyAdapter,
  remotiveAdapter,
  arbeitnowAdapter,
  himalayasAdapter,
  jobicyAdapter,
  workingNomadsAdapter,
  landingJobsAdapter,
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
registerJobSource(himalayasAdapter);
registerJobSource(jobicyAdapter);
registerJobSource(workingNomadsAdapter);
registerJobSource(landingJobsAdapter);
// No-ops until FREELANCER_OAUTH_TOKEN / GURU_API_KEY are configured — see
// each adapter's file for what's needed to activate it.
registerJobSource(freelancerComAdapter);
registerJobSource(guruComAdapter);

const REJECTED_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const DEDUPE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A normalized fingerprint of title+description, so the same posting
 * reappearing under a different externalUrl on a different board (very
 * common — the same remote job gets cross-posted to RemoteOK, WWR,
 * Himalayas, etc.) gets caught. Plain URL-equality dedup (below) misses
 * this entirely since every board mints its own URL for the same job.
 */
function computeDedupeKey(job) {
  const normalizedTitle = (job.title || "").toLowerCase().trim().replace(/\s+/g, " ");
  const normalizedDesc = (job.description || "").toLowerCase().trim().slice(0, 300).replace(/\s+/g, " ");
  return crypto.createHash("sha256").update(`${normalizedTitle}|${normalizedDesc}`).digest("hex");
}

// Common upfront-payment/equipment-fee scam patterns seen on public job
// boards — a legitimate client never asks a freelancer to pay them (or a
// third party) before or during work. Catching this before the
// feasibility check costs zero Claude calls and stops a proposal ever
// going out to what's very likely a scam.
const SCAM_PATTERNS = [
  /pay(?:ment)?\s+(?:a\s+)?(?:small\s+)?(?:processing|registration|training|starter|activation)\s+fee/i,
  /purchase\s+(?:your\s+own\s+)?(?:equipment|software|starter\s+kit)\s+(?:before|to\s+start|to\s+begin)/i,
  /send\s+(?:us\s+)?(?:a\s+)?(?:deposit|fee)\s+(?:via|through)\s+(?:western\s+union|moneygram|gift\s+card|bitcoin|crypto)/i,
  /wire\s+transfer.{0,40}(?:before|prior to)\s+(?:starting|training)/i,
  /(?:western\s+union|moneygram)\s+.{0,30}(?:fee|deposit|payment)/i,
];

function looksLikeScam(job) {
  const text = `${job.title || ""} ${job.description || ""}`;
  return SCAM_PATTERNS.some((re) => re.test(text));
}

// A live test run (2026-09-11) showed the real problem with these boards:
// most postings are full-time employment, not freelance work, and their
// titles almost always say so explicitly ("... (Full-Time)", "Full-Time
// Employment Position", W-2/PTO/benefits language) — see e.g. "Porkbun:
// Live Technical Support Representative — Full-Time — $40,000/year +
// Benefits". Each one still cost a real Claude feasibility call before
// being correctly rejected. This is a free, zero-Claude-cost pre-filter
// on the title alone (descriptions are too noisy/negation-prone to trust)
// so a genuine freelance/contract/project posting is never at risk of a
// false match — the moment "contract", "freelance", "project-based", or
// "per hour"/"hourly" also appears in the title, it's treated as freelance
// work regardless of the full-time signal.
const FULL_TIME_TITLE_PATTERN = /\b(full[\s-]?time|permanent\s+position|w-?2\s+employee)\b/i;
const FREELANCE_TITLE_OVERRIDE = /\b(contract|freelance|project[\s-]based|per\s+hour|hourly|gig)\b/i;

function looksLikeFullTimeRole(job) {
  const title = job.title || "";
  return FULL_TIME_TITLE_PATTERN.test(title) && !FREELANCE_TITLE_OVERRIDE.test(title);
}

/**
 * A NOT_FEASIBLE job is dead weight the moment it's rejected — it will
 * never move again, and with 8 job-board sources now feeding in, the Jobs
 * list would otherwise fill up with hundreds of things nobody will ever
 * look at. Deletes anything rejected more than 1 day ago — long enough
 * that a queued FEASIBILITY incident retry (or a human glancing at the
 * Jobs tab) still finds the job there instead of racing this cleanup.
 *
 * Every row referencing the job (AgentRun, Proposal, Deliverable, Payment
 * — none of them cascade) has to go first. This was missing Proposal:
 * a job that got a proposal drafted before later being re-flagged
 * NOT_FEASIBLE (e.g. a stale `feasible:true` re-checked by the retry
 * sweep after the category gate tightened) still carries one, and
 * deleting the Job first threw a real foreign-key error in production —
 * seen live crashing this sweep every 5 minutes on the founder's Mac.
 */
export async function cleanupRejectedJobs() {
  const cutoff = new Date(Date.now() - REJECTED_JOB_TTL_MS);
  const stale = await prisma.job.findMany({
    where: { status: "NOT_FEASIBLE", updatedAt: { lt: cutoff } },
    select: { id: true },
  });
  if (stale.length === 0) return { deleted: 0 };

  const ids = stale.map((j) => j.id);
  await prisma.agentRun.deleteMany({ where: { jobId: { in: ids } } });
  await prisma.proposal.deleteMany({ where: { jobId: { in: ids } } });
  await prisma.deliverable.deleteMany({ where: { jobId: { in: ids } } });
  await prisma.payment.deleteMany({ where: { jobId: { in: ids } } });
  await prisma.job.deleteMany({ where: { id: { in: ids } } });
  return { deleted: ids.length };
}

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

        const dedupeKey = computeDedupeKey(job);
        const crossPosted = await prisma.job.findFirst({
          where: { dedupeKey, createdAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) } },
        });
        if (crossPosted) continue;

        if (looksLikeScam(job)) {
          // Never even create the job row — nothing to show, nothing to
          // process, just a log line. Not worth a RejectionLog entry
          // either (that's for legitimate-but-out-of-scope categories,
          // not scams).
          console.log(`[hunter] skipped likely scam posting: "${job.title}" (${job.source})`);
          continue;
        }

        if (looksLikeFullTimeRole(job)) {
          // Same reasoning as the scam filter: this is never something we
          // could deliver as a freelance operation (it's an employment
          // relationship, not a project), so there is nothing a Claude
          // feasibility call would add — it would just spend money to
          // reach the same NOT_FEASIBLE conclusion the title already
          // makes obvious. Free job boards skew heavily toward full-time
          // listings, so this materially cuts wasted API spend.
          console.log(`[hunter] skipped full-time listing: "${job.title}" (${job.source})`);
          continue;
        }

        // Deliberately no Client record yet — a job board posting with an
        // extractable email isn't a client relationship until we've
        // actually sent them a proposal. Attaching a Client at mere
        // discovery time (an earlier version of this) meant the Clients
        // tab showed companies we'd never contacted, just because their
        // job post happened to contain an email address. See
        // proposalAgent.js for where the Client actually gets created —
        // at the moment a proposal is genuinely sent, not before.
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
            dedupeKey,
            status: "DISCOVERED",
          },
        });
        discovered += 1;

        // checkFeasibility() itself hard-skips anything outside Worker
        // Agent's SUPPORTED_CATEGORIES before spending a Claude call — that
        // gate lives there (not here) so it also covers jobs reprocessed by
        // the incident retry sweep, not just fresh discoveries. Every job
        // is still gated by feasibility before a proposal is ever drafted;
        // each job's processing is isolated so one bad job can't stop the
        // rest of this batch.
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

    // scheduler.js escalates a HUNTER failure to the owner immediately
    // (recordAndEscalateNow, not the retry queue) since a sweep-style
    // failure has no jobId to retry against — but that means a one-off
    // transient failure (a job board timing out, say) stays flagged
    // "needs you" forever even after this very next successful run
    // proves it's fine again. Clear it here instead of leaving that for
    // a manual "Mark resolved".
    await prisma.incident.updateMany({
      where: { source: "HUNTER", status: { in: ["OPEN", "ESCALATED"] } },
      data: { status: "RESOLVED" },
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
