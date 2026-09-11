import cron from "node-cron";
import { runHunterAgent, cleanupRejectedJobs } from "./agents/hunterAgent.js";
import { sweepOverduePayments } from "./agents/paymentAgent.js";
import { processInbox } from "./agents/inboxAgent.js";
import { advancePipeline } from "./agents/pipelineAgent.js";
import { sendWeeklyDigest } from "./agents/digestAgent.js";
import { retrySweep, recordAndEscalateNow } from "./services/incidents.js";

/**
 * The 24x7 loop.
 * - Hunter Agent (discover → feasibility-gate → draft/auto-send) every 10 min.
 * - Inbox Agent (read client replies, detect accept/reject/counter) every 10 min.
 * - Pipeline Agent (ACCEPTED → Worker → Delivery → Invoice, unattended) every 10 min.
 * - Payment sweep (chase overdue invoices) every 6 hours.
 * - Incident retry sweep every 5 min — the self-healing loop that retries
 *   failed agent runs automatically and only pulls the owner in once a
 *   failure won't resolve on its own.
 * A client saying "yes" is the one event that used to need a human to
 * notice — the Inbox Agent now sources that automatically wherever we
 * emailed the proposal (see inboxAgent.js for where that doesn't apply,
 * e.g. Upwork, which still needs the dashboard's manual accept/reject).
 */
export function startScheduler() {
  cron.schedule("*/10 * * * *", async () => {
    try {
      await runHunterAgent();
    } catch (err) {
      console.error("[scheduler] hunter agent run failed:", err);
      await recordAndEscalateNow("HUNTER", err);
    }
  });

  cron.schedule("*/10 * * * *", async () => {
    try {
      await processInbox();
    } catch (err) {
      console.error("[scheduler] inbox agent run failed:", err);
    }
  });

  cron.schedule("*/10 * * * *", async () => {
    try {
      await advancePipeline();
    } catch (err) {
      console.error("[scheduler] pipeline sweep failed:", err);
      await recordAndEscalateNow("PIPELINE", err);
    }
  });

  cron.schedule("0 */6 * * *", async () => {
    try {
      await sweepOverduePayments();
    } catch (err) {
      console.error("[scheduler] payment sweep failed:", err);
      await recordAndEscalateNow("PAYMENT_SWEEP", err);
    }
  });

  cron.schedule("*/5 * * * *", async () => {
    try {
      await retrySweep();
    } catch (err) {
      console.error("[scheduler] incident retry sweep itself failed:", err);
    }
  });

  // Rejected jobs are dead weight the moment they're rejected — clears
  // anything NOT_FEASIBLE for 5+ minutes so the Jobs list stays readable
  // even with 8 sources feeding in. The category is preserved in
  // RejectionLog first (see feasibilityAgent.js/proposalAgent.js) so the
  // weekly digest's growth-opportunity scan still works after cleanup.
  cron.schedule("*/5 * * * *", async () => {
    try {
      await cleanupRejectedJobs();
    } catch (err) {
      console.error("[scheduler] rejected-job cleanup failed:", err);
    }
  });

  // Every Monday 8am UTC — the "you don't have to check the dashboard" email.
  cron.schedule("0 8 * * 1", async () => {
    try {
      await sendWeeklyDigest();
    } catch (err) {
      console.error("[scheduler] weekly digest failed:", err);
    }
  });

  console.log(
    "[scheduler] Hunter/Inbox/Pipeline every 10 min, payment sweep every 6h, incident retry sweep every 5 min, weekly digest Mondays 8am UTC"
  );
}
