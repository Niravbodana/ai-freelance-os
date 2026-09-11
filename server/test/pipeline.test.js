import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db/client.js";
import { SUPPORTED_CATEGORIES } from "../src/agents/workerAgent.js";

/**
 * Regression test for the revision-loop bug found via manual live testing
 * (see README's "The revision loop" section): a QA fail used to make
 * Pipeline Agent re-run Delivery Agent's QA check on the same unrevised
 * content forever, because nothing routed the job back to Worker Agent
 * first. This test exercises the exact query logic pipelineAgent.js uses
 * to decide "does this job need Worker or Delivery next" and asserts a
 * needsRevision job lands in the Worker bucket, never the Delivery one.
 *
 * Requires a real Postgres reachable via DATABASE_URL (a scratch/dev DB —
 * this test creates and deletes real rows). Run with: npm test
 */

let jobId;

before(async () => {
  const client = await prisma.client.create({
    data: { name: "Test Co", email: "test@example.com", platform: "OUTREACH" },
  });
  const job = await prisma.job.create({
    data: {
      source: "OUTREACH",
      title: "Pipeline routing test job",
      description: "test brief",
      category: "content",
      status: "IN_PROGRESS",
      clientId: client.id,
    },
  });
  jobId = job.id;
  await prisma.deliverable.create({
    data: { jobId, content: "v1 draft", qaPassed: false, needsRevision: true, qaFeedback: "FAIL: too short" },
  });
});

after(async () => {
  await prisma.deliverable.deleteMany({ where: { jobId } });
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  await prisma.job.delete({ where: { id: jobId } });
  if (job?.clientId) await prisma.client.deleteMany({ where: { id: job.clientId } });
});

test("a needsRevision job matches Pipeline Agent's toWork query", async () => {
  const matches = await prisma.job.findMany({
    where: {
      category: { in: SUPPORTED_CATEGORIES },
      OR: [
        { status: "ACCEPTED", deliverable: null },
        { status: "IN_PROGRESS", deliverable: { needsRevision: true } },
      ],
    },
  });
  assert.ok(matches.some((j) => j.id === jobId), "needsRevision job should be picked up for a Worker Agent re-run");
});

test("a needsRevision job does NOT match Pipeline Agent's toDeliver condition", async () => {
  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { deliverable: true } });
  const wouldRunDelivery = job.deliverable && !job.deliverable.qaPassed && !job.deliverable.needsRevision;
  assert.equal(wouldRunDelivery, false, "Delivery Agent must not re-check unrevised content");
});

test("clearing needsRevision makes it eligible for Delivery Agent instead", async () => {
  await prisma.deliverable.update({ where: { jobId }, data: { needsRevision: false } });
  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { deliverable: true } });
  const wouldRunDelivery = job.deliverable && !job.deliverable.qaPassed && !job.deliverable.needsRevision;
  assert.equal(wouldRunDelivery, true, "once revised, Delivery Agent should pick it up");
});
