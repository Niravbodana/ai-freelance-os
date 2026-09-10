import cron from "node-cron";
import { runHunterAgent } from "./agents/hunterAgent.js";
import { sweepOverduePayments } from "./agents/paymentAgent.js";
import { retrySweep, recordAndEscalateNow } from "./services/incidents.js";

/**
 * The 24x7 loop.
 * - Hunter Agent (discover → feasibility-gate → draft/auto-send) every 15 min.
 * - Payment sweep (chase overdue invoices) every 6 hours.
 * - Incident retry sweep every 5 min — the self-healing loop that retries
 *   failed agent runs automatically and only pulls the owner in once a
 *   failure won't resolve on its own.
 * Worker/Delivery/invoicing stay a chain triggered from the dashboard once a
 * job is ACCEPTED — a client saying "yes" is the one event we can't source
 * automatically without their reply, everything after it can run unattended.
 */
export function startScheduler() {
  cron.schedule("*/15 * * * *", async () => {
    try {
      await runHunterAgent();
    } catch (err) {
      console.error("[scheduler] hunter agent run failed:", err);
      await recordAndEscalateNow("HUNTER", err);
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

  console.log("[scheduler] Hunter every 15 min, payment sweep every 6h, incident retry sweep every 5 min");
}
