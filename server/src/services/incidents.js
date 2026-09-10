import { prisma } from "../db/client.js";
import { notifyOwner } from "./notify.js";

/**
 * The self-healing layer. Every agent failure becomes an Incident instead
 * of an immediate email — a scheduled sweep (see scheduler.js) retries it
 * automatically. Only once retries are exhausted, or there's no automatic
 * retry path for that kind of failure, does it get ESCALATED and the owner
 * is pulled in. That's the one moment a human is actually needed; every
 * other failure is meant to fix itself without anyone noticing.
 *
 * Agents register their own retry function (same pattern as job-source
 * adapters in hunterAgent.js) so this file never has to import every agent
 * module directly.
 */
const retryHandlers = {};

export function registerRetryHandler(source, fn) {
  retryHandlers[source] = fn;
}

export async function recordIncident({ source, jobId, message, stack, maxRetries }) {
  return prisma.incident.create({
    data: {
      source,
      jobId: jobId ?? null,
      message: String(message ?? "").slice(0, 4000),
      stack: stack ? String(stack).slice(0, 4000) : null,
      maxRetries: maxRetries ?? 3,
    },
  });
}

/**
 * For failures that can't wait for the next sweep — an uncaught exception
 * or unhandled rejection that could mean the process itself is in trouble.
 * These escalate immediately rather than going through the retry queue.
 */
export async function recordAndEscalateNow(source, err) {
  const incident = await recordIncident({ source, message: err?.message || String(err), stack: err?.stack });
  await prisma.incident.update({ where: { id: incident.id }, data: { status: "ESCALATED" } });
  await notifyOwner(`System error: ${source}`, `${err?.message || err}\n\n${err?.stack || ""}`);
  return incident;
}

const RETRY_BATCH_LIMIT = 20;

export async function retrySweep() {
  const incidents = await prisma.incident.findMany({
    where: { status: "OPEN" },
    orderBy: { createdAt: "asc" },
    take: RETRY_BATCH_LIMIT,
  });

  let retried = 0;
  let resolved = 0;
  let escalated = 0;

  for (const incident of incidents) {
    const handler = incident.jobId ? retryHandlers[incident.source] : null;

    if (incident.retryCount >= incident.maxRetries || !handler) {
      await escalate(incident);
      escalated += 1;
      continue;
    }

    retried += 1;
    try {
      await handler(incident.jobId);
      await prisma.incident.update({ where: { id: incident.id }, data: { status: "RESOLVED" } });
      resolved += 1;
    } catch (err) {
      const nextCount = incident.retryCount + 1;
      await prisma.incident.update({
        where: { id: incident.id },
        data: { retryCount: nextCount, lastAttemptAt: new Date(), message: String(err?.message || err).slice(0, 4000) },
      });
      if (nextCount >= incident.maxRetries) {
        await escalate({ ...incident, retryCount: nextCount });
        escalated += 1;
      }
    }
  }

  return { checked: incidents.length, retried, resolved, escalated };
}

async function escalate(incident) {
  await prisma.incident.update({ where: { id: incident.id }, data: { status: "ESCALATED" } });
  await notifyOwner(
    `Needs you: ${incident.source} kept failing`,
    `Job: ${incident.jobId ?? "n/a"}\nRetried ${incident.retryCount} time(s), still failing.\nLatest error: ${incident.message}\nOpen the dashboard's Incidents panel to see details and decide next steps.`
  );
}
