import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { jobsRouter } from "./routes/jobs.js";
import { agentsRouter } from "./routes/agents.js";
import { statsRouter } from "./routes/stats.js";
import { incidentsRouter } from "./routes/incidents.js";
import { adminRouter } from "./routes/admin.js";
import { leadsRouter } from "./routes/leads.js";
import { startScheduler } from "./scheduler.js";
import { recordAndEscalateNow } from "./services/incidents.js";
import { loadConfigCache } from "./services/config.js";

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

// This dashboard runs job data, sent proposals, and payment actions with no
// login of its own — anyone with the URL could otherwise create/approve/
// mark-paid on real jobs. Set DASHBOARD_USER/DASHBOARD_PASSWORD once this
// is deployed publicly; the browser's native login prompt handles the rest.
// Left unset only for local dev — a public deploy without it is a real
// security gap, not a convenience, so this warns loudly instead of staying
// silent about it.
if (process.env.DASHBOARD_USER && process.env.DASHBOARD_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === "/health") return next(); // let uptime checks through unauthenticated
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
      if (user === process.env.DASHBOARD_USER && pass === process.env.DASHBOARD_PASSWORD) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="AI Freelance OS"');
    res.status(401).send("Authentication required");
  });
} else {
  console.warn(
    "[security] DASHBOARD_USER/DASHBOARD_PASSWORD not set — the dashboard and its API are running with NO AUTH. Fine for local dev only; set both before deploying anywhere reachable from the internet."
  );
}

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api/jobs", jobsRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/stats", statsRouter);
app.use("/api/incidents", incidentsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/leads", leadsRouter);

// Serve the built dashboard from the same origin/process as the API. This
// is what makes the basic-auth login above "just work" via the browser's
// native prompt with no CORS/cross-origin credential complexity — one URL,
// one login, no separate frontend deployment needed. Only kicks in when
// client/dist exists (i.e. `npm run build` was run in client/), so local
// dev (where you run the Vite dev server separately on :5173) is unaffected.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(__dirname, "..", "..", "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

// Safety net for any route that throws synchronously or forwards to next(err)
// without its own try/catch — logs an Incident instead of a bare 500 with
// no record of what happened.
app.use((err, _req, res, _next) => {
  console.error("[express] unhandled route error:", err);
  recordAndEscalateNow("EXPRESS_ROUTE", err).catch(() => {});
  res.status(500).json({ error: "Internal error — logged as an incident." });
});

const port = process.env.PORT || 4000;

// Load DB-stored credential overrides (Admin Settings) into memory before
// anything tries to use them — agents/scheduler read via getConfig(), which
// falls back to env vars until this cache is populated.
await loadConfigCache().catch((err) => {
  console.error("[startup] failed to load Admin Settings from DB (will use env vars only):", err.message);
});

app.listen(port, () => {
  console.log(`ai-freelance-os server listening on :${port}`);
  startScheduler();
});
