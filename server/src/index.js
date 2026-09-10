import "dotenv/config";
import express from "express";
import cors from "cors";
import { jobsRouter } from "./routes/jobs.js";
import { agentsRouter } from "./routes/agents.js";
import { statsRouter } from "./routes/stats.js";
import { startScheduler } from "./scheduler.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api/jobs", jobsRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/stats", statsRouter);

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`ai-freelance-os server listening on :${port}`);
  startScheduler();
});
