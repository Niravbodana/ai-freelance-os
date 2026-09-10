import "dotenv/config";
import express from "express";
import cors from "cors";
import { jobsRouter } from "./routes/jobs.js";
import { agentsRouter } from "./routes/agents.js";
import { statsRouter } from "./routes/stats.js";
import { incidentsRouter } from "./routes/incidents.js";
import { startScheduler } from "./scheduler.js";
import { recordAndEscalateNow } from "./services/incidents.js";

// Crash-safety net: an error that would otherwise silently kill the process
// (or the whole event loop) becomes an escalated Incident + an immediate
// email instead. This is the backstop under the agent-level retry system —
// it only fires for something that slipped past every try/catch.
process.on("uncaughtException", (err) => {
  console.error("[process] uncaughtException:", err);
  recordAndEscalateNow("PROCESS_UNCAUGHT_EXCEPTION", err).catch(() => {});
});
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error("[process] unhandledRejection:", err);
  recordAndEscalateNow("PROCESS_UNHANDLED_REJECTION", err).catch(() => {});
});

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api/jobs", jobsRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/stats", statsRouter);
app.use("/api/incidents", incidentsRouter);

// Safety net for any route that throws synchronously or forwards to next(err)
// without its own try/catch — logs an Incident instead of a bare 500 with
// no record of what happened.
app.use((err, _req, res, _next) => {
  console.error("[express] unhandled route error:", err);
  recordAndEscalateNow("EXPRESS_ROUTE", err).catch(() => {});
  res.status(500).json({ error: "Internal error — logged as an incident." });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`ai-freelance-os server listening on :${port}`);
  startScheduler();
});
