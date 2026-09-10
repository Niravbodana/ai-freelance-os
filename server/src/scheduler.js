import cron from "node-cron";
import { runHunterAgent } from "./agents/hunterAgent.js";
import { sweepOverduePayments } from "./agents/paymentAgent.js";

/**
 * The 24x7 loop.
 * - Hunter Agent (discover → feasibility-gate → draft/auto-send) every 15 min.
 * - Payment sweep (chase overdue invoices) every 6 hours.
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
    }
  });

  cron.schedule("0 */6 * * *", async () => {
    try {
      await sweepOverduePayments();
    } catch (err) {
      console.error("[scheduler] payment sweep failed:", err);
    }
  });

  console.log("[scheduler] Hunter Agent every 15 min, payment sweep every 6 hours");
}
