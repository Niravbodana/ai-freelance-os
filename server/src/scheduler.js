import cron from "node-cron";
import { runHunterAgent } from "./agents/hunterAgent.js";

/**
 * The 24x7 loop. Hunter Agent polls all registered job sources every
 * 15 minutes. Proposal/Worker/Delivery stay human-triggered from the
 * dashboard for the MVP (approval-gated by design), but wiring them into
 * this same cron once trust is established is a one-line change.
 */
export function startScheduler() {
  cron.schedule("*/15 * * * *", async () => {
    try {
      await runHunterAgent();
    } catch (err) {
      console.error("[scheduler] hunter agent run failed:", err);
    }
  });
  console.log("[scheduler] Hunter Agent scheduled every 15 minutes");
}
