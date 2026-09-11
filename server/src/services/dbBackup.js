import { prisma } from "../db/client.js";
import { notifyOwnerWithAttachment } from "./notify.js";
import { recordIncident } from "./incidents.js";

/**
 * The actual business data (jobs, clients, proposals, payments,
 * deliverables) has no backup anywhere — config.js's export/import only
 * covers the encrypted Setting table (credentials), not this. A Railway
 * DB wipe or a bad migration would otherwise lose every client
 * relationship and payment record with no way back.
 *
 * Rather than shelling out to pg_dump (not guaranteed present in the
 * Railway container, and needs its own credential handling), this exports
 * the tables that actually matter as one JSON document via Prisma — small
 * enough to email as an attachment, so the owner's inbox becomes the
 * off-site backup location with zero extra infra or credentials.
 */
export async function runDatabaseBackup() {
  const [jobs, clients, proposals, payments, deliverables] = await Promise.all([
    prisma.job.findMany(),
    prisma.client.findMany(),
    prisma.proposal.findMany(),
    prisma.payment.findMany(),
    prisma.deliverable.findMany(),
  ]);

  const backup = {
    exportedAt: new Date().toISOString(),
    counts: { jobs: jobs.length, clients: clients.length, proposals: proposals.length, payments: payments.length, deliverables: deliverables.length },
    jobs,
    clients,
    proposals,
    payments,
    deliverables,
  };

  const json = JSON.stringify(backup, null, 2);
  const dateStr = new Date().toISOString().slice(0, 10);

  try {
    await notifyOwnerWithAttachment(
      `Weekly database backup — ${dateStr}`,
      `Attached: a full export of jobs/clients/proposals/payments/deliverables as of ${backup.exportedAt}.\n` +
        `${backup.counts.jobs} jobs, ${backup.counts.clients} clients, ${backup.counts.payments} payments.\n\n` +
        `Keep this email — it's the only backup of your business data outside the live database.`,
      { filename: `ai-freelance-os-backup-${dateStr}.json`, content: json, contentType: "application/json" }
    );
  } catch (err) {
    // A failed backup is worth escalating like any other failure — silently
    // skipping a week would defeat the point.
    await recordIncident({ source: "DB_BACKUP", message: err.message || err, stack: err.stack, maxRetries: 0 });
    throw err;
  }

  return backup.counts;
}
