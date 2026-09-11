import { useEffect, useState } from "react";
import { api } from "../api/client.js";

const AUTO_REFRESH_MS = 8_000;

// One employee per agent — face tone, hair, shirt color, desk position.
// This is a literal floor plan of the pipeline: what you'd see if you
// walked into the office and looked over everyone's shoulder.
const AGENT_META = {
  HUNTER: { name: "Hunter", role: "Job Scout", shirt: "#3b82f6", skin: "#e0ac69", hair: "#3a2a1d" },
  FEASIBILITY: { name: "Vetter", role: "Feasibility Checker", shirt: "#8b5cf6", skin: "#f1c27d", hair: "#111111" },
  PROPOSAL: { name: "Pitch", role: "Proposal Writer", shirt: "#f59e0b", skin: "#c68642", hair: "#2b1b0e" },
  WORKER: { name: "Crafter", role: "Work Builder", shirt: "#10b981", skin: "#ffdbac", hair: "#6b3b1f" },
  DELIVERY: { name: "Inspector", role: "QA & Delivery", shirt: "#ec4899", skin: "#e0ac69", hair: "#1a1a1a" },
  PAYMENT: { name: "Cashier", role: "Invoicing", shirt: "#eab308", skin: "#f1c27d", hair: "#4a2c15" },
  INBOX: { name: "Reception", role: "Inbox Reader", shirt: "#06b6d4", skin: "#ffdbac", hair: "#2b1b0e" },
  PIPELINE: { name: "Manager", role: "Pipeline Coordinator", shirt: "#f97316", skin: "#c68642", hair: "#111111" },
  TESTIMONIAL: { name: "Scout", role: "Testimonials", shirt: "#facc15", skin: "#e0ac69", hair: "#3a2a1d" },
  LEADS: { name: "Prospector", role: "Leads Importer", shirt: "#f43f5e", skin: "#ffdbac", hair: "#1a1a1a" },
  CONTRACT: { name: "Notary", role: "Contract Drafter", shirt: "#14b8a6", skin: "#f1c27d", hair: "#6b3b1f" },
  DIGEST: { name: "Reporter", role: "Weekly Digest", shirt: "#6366f1", skin: "#c68642", hair: "#2b1b0e" },
};

const AGENT_ORDER = ["HUNTER", "FEASIBILITY", "PROPOSAL", "WORKER", "DELIVERY", "PIPELINE", "INBOX", "PAYMENT", "CONTRACT", "TESTIMONIAL", "LEADS", "DIGEST"];

function timeAgo(dateStr) {
  if (!dateStr) return null;
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function describeRun(run) {
  if (!run) return "Waiting for their first task.";
  const subject = run.job?.title ? `"${run.job.title}"` : null;
  if (run.status === "RUNNING") return subject ? `Working on ${subject}...` : "Working...";
  if (run.status === "SUCCESS") return subject ? `Done: ${subject}` : run.log ? run.log.slice(0, 70) : "Finished the last task.";
  if (run.status === "FAILED") return subject ? `Stuck on ${subject}` : "Hit an error.";
  return "At their desk.";
}

function statusOf(run) {
  if (!run) return "idle";
  if (run.status === "RUNNING") return "working";
  if (run.status === "FAILED") return "error";
  if (run.status === "SUCCESS") return "done";
  return "idle";
}

const STATUS_LABEL = { idle: "At desk", working: "Working", done: "Done", error: "Stuck" };

function Character({ meta, status, isCeo }) {
  return (
    <div className={`char status-${status}`}>
      <div className="char-hair" style={{ background: meta.hair }} />
      <div className="char-head" style={{ background: meta.skin }}>
        <div className="char-eyes">
          <span /> <span />
        </div>
        <div className="char-mouth" />
      </div>
      <div className="char-body" style={{ background: meta.shirt }}>
        {isCeo && <div className="char-tie" />}
      </div>
    </div>
  );
}

function Desk({ agentType, run }) {
  const meta = AGENT_META[agentType];
  const status = statusOf(run);
  return (
    <div className="cubicle">
      {status === "error" && <div className="alert-badge">!</div>}
      <div className="speech-bubble">{describeRun(run)}</div>
      <Character meta={meta} status={status} />
      <div className="monitor">
        <div className={`screen status-${status}`}>
          {status === "working" && <span className="screen-cursor" />}
          {status === "done" && <span className="screen-icon">✓</span>}
          {status === "error" && <span className="screen-icon">✕</span>}
        </div>
        <div className="monitor-stand" />
      </div>
      <div className="desk-top" />
      <div className="desk-front" />
      <div className="nameplate">
        <strong>{meta.name}</strong>
        <span>{meta.role}</span>
      </div>
      <div className="desk-footer">
        <span className={`pill desk-status-pill status-${status}`}>{STATUS_LABEL[status]}</span>
        {run?.startedAt && <span className="desk-time">{timeAgo(run.startedAt)}</span>}
      </div>
    </div>
  );
}

export default function OfficeView() {
  const [runs, setRuns] = useState([]);
  const [incidents, setIncidents] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    try {
      const [runsRes, incidentsRes, statsRes] = await Promise.all([
        api.listRuns(),
        api.listIncidents("ESCALATED"),
        api.stats(),
      ]);
      setRuns(runsRes);
      setIncidents(incidentsRes);
      setStats(statsRes);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  const latestByAgent = {};
  for (const run of runs) {
    if (!latestByAgent[run.agent] || new Date(run.startedAt) > new Date(latestByAgent[run.agent].startedAt)) {
      latestByAgent[run.agent] = run;
    }
  }

  const stuckAgents = AGENT_ORDER.filter((a) => statusOf(latestByAgent[a]) === "error").map((a) => AGENT_META[a].name);
  const needsApproval = stats?.pendingApprovalCount || 0;

  let ceoMessage;
  if (incidents.length > 0) {
    const first = incidents[0];
    ceoMessage = `Heads up — "${first.source}" has been stuck since retries ran out${incidents.length > 1 ? ` (+${incidents.length - 1} more)` : ""}. I need you to take a look.`;
  } else if (stuckAgents.length > 0) {
    ceoMessage = `${stuckAgents.join(", ")} hit an error — auto-retry is on it. I'll only interrupt you if it doesn't resolve on its own.`;
  } else if (needsApproval > 0) {
    ceoMessage = `${needsApproval} proposal${needsApproval > 1 ? "s are" : " is"} waiting on your approval — no rush, but they're sitting in the queue.`;
  } else {
    ceoMessage = "Everything's running smoothly — nothing needs you right now.";
  }
  const ceoAlert = incidents.length > 0;

  return (
    <div className="office-room">
      {error && <p style={{ color: "#dc2626" }}>{error}</p>}
      {loading && <p style={{ color: "#6b7280" }}>Opening the office...</p>}

      <div className="office-wall">
        <div className="window" />
        <div className="window" />
        <div className="wall-clock">
          <div className="clock-hand hour" />
          <div className="clock-hand minute" />
        </div>
      </div>

      <div className={`ceo-office${ceoAlert ? " alert" : ""}`}>
        <div className="ceo-plaque">CEO Office</div>
        <div className="ceo-plant" />
        <Character meta={{ shirt: "#1e293b", skin: "#e0ac69", hair: "#111111" }} status={ceoAlert ? "error" : "done"} isCeo />
        <div className="ceo-desk-top" />
        <div className="ceo-desk-front" />
        <div className={`ceo-speech${ceoAlert ? " alert" : ""}`}>{ceoMessage}</div>
      </div>

      <div className="office-floor">
        <div className="rug" />
        <div className="plant plant-1" />
        <div className="plant plant-2" />
        <div className="water-cooler">
          <div className="cooler-jug" />
          <div className="cooler-base" />
        </div>

        <div className="desks-grid">
          {AGENT_ORDER.map((agentType) => (
            <Desk key={agentType} agentType={agentType} run={latestByAgent[agentType]} />
          ))}
        </div>
      </div>
    </div>
  );
}
