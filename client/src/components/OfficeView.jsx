import { useEffect, useState } from "react";
import { api } from "../api/client.js";

const AUTO_REFRESH_MS = 8_000;
const WANDER_ROTATE_MS = 60_000;

const AGENT_META = {
  HUNTER: { name: "Hunter", role: "Job Scout", shirt: "#3b82f6", skin: "#e0ac69", hair: "#3a2a1d", style: "short" },
  FEASIBILITY: { name: "Vetter", role: "Feasibility Checker", shirt: "#8b5cf6", skin: "#f1c27d", hair: "#111111", style: "long" },
  PROPOSAL: { name: "Pitch", role: "Proposal Writer", shirt: "#f59e0b", skin: "#c68642", hair: "#2b1b0e", style: "short" },
  WORKER: { name: "Crafter", role: "Work Builder", shirt: "#10b981", skin: "#ffdbac", hair: "#6b3b1f", style: "long" },
  DELIVERY: { name: "Inspector", role: "QA & Delivery", shirt: "#ec4899", skin: "#e0ac69", hair: "#1a1a1a", style: "long" },
  PAYMENT: { name: "Cashier", role: "Invoicing", shirt: "#eab308", skin: "#f1c27d", hair: "#4a2c15", style: "short" },
  INBOX: { name: "Reception", role: "Inbox Reader", shirt: "#06b6d4", skin: "#ffdbac", hair: "#2b1b0e", style: "long" },
  PIPELINE: { name: "Manager", role: "Pipeline Coordinator", shirt: "#f97316", skin: "#c68642", hair: "#111111", style: "short" },
  TESTIMONIAL: { name: "Scout", role: "Testimonials", shirt: "#facc15", skin: "#e0ac69", hair: "#3a2a1d", style: "long" },
  LEADS: { name: "Prospector", role: "Leads Importer", shirt: "#f43f5e", skin: "#ffdbac", hair: "#1a1a1a", style: "short" },
  CONTRACT: { name: "Notary", role: "Contract Drafter", shirt: "#14b8a6", skin: "#f1c27d", hair: "#6b3b1f", style: "long" },
  DIGEST: { name: "Reporter", role: "Weekly Digest", shirt: "#6366f1", skin: "#c68642", hair: "#2b1b0e", style: "short" },
};

const AGENT_ORDER = [
  "HUNTER",
  "FEASIBILITY",
  "PROPOSAL",
  "WORKER",
  "DELIVERY",
  "PIPELINE",
  "INBOX",
  "PAYMENT",
  "CONTRACT",
  "TESTIMONIAL",
  "LEADS",
  "DIGEST",
];

// Positions are % of the floor-plate image (1536×1024), matched to the
// isometric office the founder asked to recreate.
const STATIONS = [
  { id: "meeting", kind: "room", label: "Meeting Room", x: 16.2, y: 17.4, roam: true },
  { id: "reception", kind: "desk", label: "Reception", agent: "INBOX", x: 47.4, y: 15.2 },
  { id: "lounge", kind: "room", label: "Lounge", x: 59.8, y: 16.8, roam: true },
  { id: "founder", kind: "cabin", label: "Founder", x: 83.6, y: 17.6, founder: true },
  { id: "hunter", kind: "desk", label: "Open Desk", agent: "HUNTER", x: 41.6, y: 32.6 },
  { id: "vetter", kind: "desk", label: "Open Desk", agent: "FEASIBILITY", x: 52.8, y: 32.4 },
  { id: "inspector", kind: "desk", label: "Open Desk", agent: "DELIVERY", x: 28.6, y: 45.2 },
  { id: "crafter", kind: "desk", label: "Open Desk", agent: "WORKER", x: 51.4, y: 46.6 },
  { id: "pitch", kind: "desk", label: "Open Desk", agent: "PROPOSAL", x: 62.8, y: 44.8 },
  { id: "empty-row", kind: "desk", label: "Shared Desk", agent: "LEADS", x: 47.8, y: 58.4 },
  { id: "pantry", kind: "room", label: "Pantry", x: 10.4, y: 49.6, roam: true },
  { id: "discussion", kind: "room", label: "Discussion", x: 18.6, y: 76.8, roam: true },
  { id: "collaboration", kind: "room", label: "Collaboration", agent: "TESTIMONIAL", x: 77.8, y: 51.6 },
  { id: "hr", kind: "cabin", label: "HR", agent: "CONTRACT", x: 73.2, y: 71.4 },
  { id: "cooler", kind: "room", label: "Water Cooler", x: 68.8, y: 22.8, roam: true },
  { id: "pipeline", kind: "desk", label: "Founder Cabin", agent: "PIPELINE", x: 79.4, y: 20.8 },
  { id: "cashier", kind: "desk", label: "Shared Desk", agent: "PAYMENT", x: 42.2, y: 58.8 },
  { id: "reporter", kind: "desk", label: "Collaboration", agent: "DIGEST", x: 82.4, y: 51.2 },
];

const BREAK_SPOTS = [
  { id: "pantry", label: "Pantry", caption: "Coffee break" },
  { id: "discussion", label: "Discussion", caption: "On the sofa" },
  { id: "lounge", label: "Lounge", caption: "Taking a breather" },
  { id: "cooler", label: "Water Cooler", caption: "Filling up" },
  { id: "meeting", label: "Meeting Room", caption: "In a huddle" },
];

const STATUS_LABEL = { idle: "Idle", working: "Working", done: "Done", error: "Stuck" };

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

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

function StationPin({ station, run, selected, onSelect }) {
  const agent = station.agent;
  const meta = agent ? AGENT_META[agent] : null;
  const status = agent ? statusOf(run) : "idle";
  const title = meta ? `${meta.name} · ${meta.role}` : station.label;

  return (
    <button
      type="button"
      className={`office-pin kind-${station.kind} status-${status}${selected ? " selected" : ""}${station.founder ? " founder-pin" : ""}`}
      style={{ left: `${station.x}%`, top: `${station.y}%` }}
      onClick={() => onSelect(station.id)}
      aria-label={title}
    >
      {status === "error" && <span className="office-pin-alert">!</span>}
      <span className="office-pin-dot" />
      <span className="office-pin-label">
        <strong>{meta ? meta.name : station.label}</strong>
        <em>{STATUS_LABEL[status]}</em>
      </span>
    </button>
  );
}

export default function OfficeView() {
  const [runs, setRuns] = useState([]);
  const [incidents, setIncidents] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [wanderTick, setWanderTick] = useState(0);
  const [selectedId, setSelectedId] = useState("founder");

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
    const wander = setInterval(() => setWanderTick((t) => t + 1), WANDER_ROTATE_MS);
    return () => {
      clearInterval(interval);
      clearInterval(wander);
    };
  }, []);

  const latestByAgent = {};
  for (const run of runs) {
    if (!latestByAgent[run.agent] || new Date(run.startedAt) > new Date(latestByAgent[run.agent].startedAt)) {
      latestByAgent[run.agent] = run;
    }
  }

  const idleAgents = AGENT_ORDER.filter((a) => statusOf(latestByAgent[a]) === "idle");
  const roamingByAgent = {};
  idleAgents.forEach((agentType, i) => {
    const spot = BREAK_SPOTS[(hashStr(agentType) + wanderTick + i) % BREAK_SPOTS.length];
    roamingByAgent[agentType] = spot;
  });

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

  const selected = STATIONS.find((s) => s.id === selectedId) || STATIONS.find((s) => s.founder);
  const selectedRun = selected?.agent ? latestByAgent[selected.agent] : null;
  const selectedMeta = selected?.agent ? AGENT_META[selected.agent] : null;
  const selectedRoam = selected?.agent ? roamingByAgent[selected.agent] : null;

  return (
    <div className="office-room">
      <div className="office-stage">
        <img
          src="/office-floor.jpg"
          alt="Isometric office floor plan with Meeting Room, Founder cabin, Pantry, Discussion, Collaboration and HR"
          className="office-plate"
        />

        {STATIONS.filter((station) => station.agent || station.founder).map((station) => (
          <StationPin
            key={station.id}
            station={station}
            run={station.agent ? latestByAgent[station.agent] : null}
            selected={selectedId === station.id}
            onSelect={setSelectedId}
          />
        ))}

        <div className={`office-ceo-bubble${ceoAlert ? " alert" : ""}`}>
          <span className="office-ceo-kicker">Founder</span>
          {ceoMessage}
        </div>
      </div>

      <div className="office-dock">
        <div className="office-inspect">
          <div className="office-inspect-kicker">{selected?.label}</div>
          <div className="office-inspect-title">
            {selected?.founder ? "You · Founder cabin" : selectedMeta ? `${selectedMeta.name} · ${selectedMeta.role}` : selected?.label}
          </div>
          <p className="office-inspect-body">
            {selected?.founder
              ? ceoMessage
              : selectedRoam && statusOf(selectedRun) === "idle"
                ? `${selectedRoam.caption} · ${selectedRoam.label}`
                : describeRun(selectedRun)}
          </p>
          {selectedRun?.startedAt && <div className="office-inspect-time">{timeAgo(selectedRun.startedAt)}</div>}
          {error && <div className="office-inspect-time">Live status paused — API unreachable.</div>}
          {loading && !error && <div className="office-inspect-time">Opening the office...</div>}
        </div>

        <div className="office-roster">
          {AGENT_ORDER.map((agentType) => {
            const meta = AGENT_META[agentType];
            const status = statusOf(latestByAgent[agentType]);
            const station = STATIONS.find((s) => s.agent === agentType);
            return (
              <button
                key={agentType}
                type="button"
                className={`office-chip status-${status}${station && selectedId === station.id ? " selected" : ""}`}
                onClick={() => station && setSelectedId(station.id)}
              >
                <span className="office-chip-swatch" style={{ background: meta.shirt }} />
                <span className="office-chip-name">{meta.name}</span>
                <span className={`pill desk-status-pill status-${status}`}>{STATUS_LABEL[status]}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
