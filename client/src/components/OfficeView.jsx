import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";

const AUTO_REFRESH_MS = 8_000;
// How often idle employees rotate to a different break-room spot — long
// enough that a refresh doesn't feel jittery, short enough that the office
// visibly isn't frozen if you watch it for a minute.
const WANDER_ROTATE_MS = 60_000;

// One employee per agent — face tone, hair, shirt color, desk position.
// This is a literal floor plan of the pipeline: what you'd see if you
// walked into the office and looked over everyone's shoulder.
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

const AGENT_ORDER = ["HUNTER", "FEASIBILITY", "PROPOSAL", "WORKER", "DELIVERY", "PIPELINE", "INBOX", "PAYMENT", "CONTRACT", "TESTIMONIAL", "LEADS", "DIGEST"];

// The break-room spots an idle employee can be found at — nobody who isn't
// actively on a task sits frozen at an empty desk. Each has its own short
// "what they're doing here" caption so it doesn't just look like people
// standing around.
const BREAK_SPOTS = [
  { id: "cafe", label: "Cafe", caption: "Coffee break" },
  { id: "smoking", label: "Smoking Zone", caption: "Quick smoke" },
  { id: "restroom", label: "Restroom", caption: "Away from desk" },
  { id: "cooler", label: "Water Cooler", caption: "Filling up" },
];

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

const STATUS_LABEL = { idle: "Away", working: "Working", done: "Done", error: "Stuck" };

// A proper illustrated figure (flat-design, not box-shaped) — head, hair,
// shoulders and arms as SVG paths so proportions and silhouette read as an
// actual person instead of stacked rectangles. `pose="standing"` (used in
// the break room) adds legs and shoes; the desk pose stops at the waist,
// same as any front-facing seated illustration where the desk hides the
// rest.
function Character({ meta, status, isCeo, walking, arriving, pose = "sitting" }) {
  const shirtDark = shade(meta.shirt, -18);
  const hairD = meta.style === "long"
    ? "M12,27 C12,12 21,3 32,3 C43,3 52,12 52,27 L52,50 C52,54 48,55 47,50 L45,30 C45,20 39,13 32,13 C25,13 19,20 19,30 L17,50 C16,55 12,54 12,50 Z"
    : "M13,26 C13,11 21,4 32,4 C43,4 51,11 51,26 C51,19 45,13 32,13 C19,13 13,19 13,26 Z";

  return (
    <div className={`char status-${status}${walking ? " walking" : ""}${arriving ? " arriving" : ""} pose-${pose}`}>
      <svg
        viewBox="0 0 64 96"
        preserveAspectRatio={pose === "standing" ? "xMidYMid meet" : "xMidYMin slice"}
        className="char-svg"
        role="img"
        aria-label={meta.name}
      >
        {pose === "standing" && (
          <>
            <ellipse cx="32" cy="92" rx="16" ry="3" className="char-shadow-el" />
            <rect x="20" y="66" width="9" height="24" rx="4" fill={shirtDark} />
            <rect x="35" y="66" width="9" height="24" rx="4" fill={shirtDark} />
            <ellipse cx="24.5" cy="91" rx="6" ry="3" fill="#2b2f36" />
            <ellipse cx="39.5" cy="91" rx="6" ry="3" fill="#2b2f36" />
          </>
        )}

        {/* torso / shoulders */}
        <path
          d="M10,90 C10,66 16,52 32,52 C48,52 54,66 54,90 Z"
          fill={meta.shirt}
        />
        {isCeo && <path d="M29,52 L35,52 L33,66 L32,74 L31,66 Z" fill="#b91c1c" />}
        {!isCeo && <path d="M10,58 C16,64 48,64 54,58 L54,66 C44,72 20,72 10,66 Z" fill={shirtDark} opacity="0.55" />}

        {/* arms resting forward (typing pose) */}
        <rect x="2" y="62" width="14" height="16" rx="7" fill={shirtDark} />
        <rect x="48" y="62" width="14" height="16" rx="7" fill={shirtDark} />
        <circle cx="9" cy="78" r="6.5" fill={meta.skin} />
        <circle cx="55" cy="78" r="6.5" fill={meta.skin} />

        {/* neck */}
        <rect x="26" y="38" width="12" height="14" rx="4" fill={meta.skin} />

        {/* head */}
        <circle cx="32" cy="28" r="17" fill={meta.skin} />
        <circle cx="32" cy="33" r="17" fill="#000" opacity="0.05" />
        <circle cx="32" cy="28" r="17" fill={meta.skin} />

        {/* hair */}
        <path d={hairD} fill={meta.hair} />

        {/* face */}
        <circle cx="26" cy="29" r="1.8" fill="#2b2f36" />
        <circle cx="38" cy="29" r="1.8" fill="#2b2f36" />
        <path d="M27,36 Q32,40 37,36" stroke="#8a5a35" strokeWidth="2" fill="none" strokeLinecap="round" />
        <path d="M21,23 Q26,18 31,22" stroke={meta.hair} strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.7" />
        <path d="M43,23 Q38,18 33,22" stroke={meta.hair} strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.7" />
      </svg>
    </div>
  );
}

// Lightens/darkens a #rrggbb hex color by `percent` (negative = darker) —
// used to derive sleeve/collar shading from each agent's base shirt color
// without hand-picking a second color per agent.
function shade(hex, percent) {
  const num = parseInt(hex.replace("#", ""), 16);
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const amt = Math.round(2.55 * percent);
  const r = clamp((num >> 16) + amt);
  const g = clamp(((num >> 8) & 0x00ff) + amt);
  const b = clamp((num & 0x0000ff) + amt);
  return `#${(0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1)}`;
}

function Desk({ agentType, run, roaming, arriving }) {
  const meta = AGENT_META[agentType];
  const status = statusOf(run);
  const atDesk = status !== "idle";

  return (
    <div className={`cubicle${atDesk ? "" : " cubicle-empty"}`}>
      {status === "error" && <div className="alert-badge">!</div>}
      {atDesk ? (
        <>
          <div className="speech-bubble">{describeRun(run)}</div>
          <Character meta={meta} status={status} arriving={arriving} />
        </>
      ) : (
        <div className="speech-bubble away-bubble">
          {roaming ? `${roaming.caption} · ${roaming.label}` : "Away from desk"}
        </div>
      )}
      <div className="laptop">
        <svg viewBox="0 0 60 40" className="laptop-svg">
          <rect x="6" y="2" width="48" height="30" rx="2" fill="#334155" />
          <rect x="9" y="5" width="42" height="24" rx="1" className={`laptop-screen status-${status}`} />
          <path d="M0,32 L60,32 L54,38 L6,38 Z" fill="#cbd5e1" />
          {status === "working" && <circle cx="30" cy="17" r="2.4" className="screen-cursor-dot" />}
          {status === "done" && (
            <path d="M22,17 L28,23 L38,11" stroke="#4ade80" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          )}
          {status === "error" && (
            <>
              <path d="M24,11 L36,23" stroke="#f87171" strokeWidth="3" strokeLinecap="round" />
              <path d="M36,11 L24,23" stroke="#f87171" strokeWidth="3" strokeLinecap="round" />
            </>
          )}
          {status === "idle" && (
            <text x="30" y="20" textAnchor="middle" fontSize="9" fill="#64748b" fontWeight="700">
              Zz
            </text>
          )}
        </svg>
      </div>
      <div className="desk-top" />
      <div className="desk-front" />
      {!atDesk && <div className="empty-chair" />}
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

function BreakRoom({ occupants }) {
  return (
    <div className="break-room">
      <div className="break-spot cafe-spot">
        <div className="cafe-counter" />
        <div className="coffee-machine" />
        <div className="snack-tray" />
        <div className="break-spot-label">Cafe</div>
        <div className="break-occupants">
          {(occupants.cafe || []).map((agentType) => (
            <Character key={agentType} meta={AGENT_META[agentType]} status="idle" walking pose="standing" />
          ))}
        </div>
      </div>

      <div className="break-spot smoking-spot">
        <div className="smoking-post" />
        <div className="ashtray" />
        <div className="break-spot-label">Smoking Zone</div>
        <div className="break-occupants">
          {(occupants.smoking || []).map((agentType) => (
            <Character key={agentType} meta={AGENT_META[agentType]} status="idle" walking pose="standing" />
          ))}
        </div>
      </div>

      <div className="break-spot restroom-spot">
        <div className="restroom-door">
          <span>WC</span>
        </div>
        <div className="break-spot-label">Restroom</div>
        <div className="break-occupants">
          {(occupants.restroom || []).map((agentType) => (
            <Character key={agentType} meta={AGENT_META[agentType]} status="idle" walking pose="standing" />
          ))}
        </div>
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
  const [wanderTick, setWanderTick] = useState(0);
  const [arrivingSet, setArrivingSet] = useState(new Set());
  const prevStatusRef = useRef({});

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
    // Idle employees rotate break spots on a slower clock than the data
    // refresh, so the office still visibly changes even between polls.
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

  // Anyone who just went from "away" to "working/done/error" gets a quick
  // run-to-desk animation instead of silently teleporting into their chair
  // — this is the "they see work come in and rush to their desk" behavior.
  useEffect(() => {
    const justArrived = new Set();
    for (const agentType of AGENT_ORDER) {
      const nowStatus = statusOf(latestByAgent[agentType]);
      const wasStatus = prevStatusRef.current[agentType];
      if (wasStatus === "idle" && nowStatus !== "idle") justArrived.add(agentType);
      prevStatusRef.current[agentType] = nowStatus;
    }
    if (justArrived.size > 0) {
      setArrivingSet(justArrived);
      const t = setTimeout(() => setArrivingSet(new Set()), 650);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);

  const idleAgents = AGENT_ORDER.filter((a) => statusOf(latestByAgent[a]) === "idle");
  const occupants = { cafe: [], smoking: [], restroom: [] };
  const roamingByAgent = {};
  idleAgents.forEach((agentType, i) => {
    // Deterministic-but-rotating placement: which spot changes every
    // WANDER_ROTATE_MS (wanderTick), and is spread out per-agent (hash) so
    // everyone doesn't clump in the same corner at once.
    const spot = BREAK_SPOTS[(hashStr(agentType) + wanderTick + i) % BREAK_SPOTS.length];
    roamingByAgent[agentType] = spot;
    if (spot.id !== "cooler") occupants[spot.id]?.push(agentType);
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

  return (
    <div className="office-room">
      {error && <p style={{ color: "#dc2626" }}>{error}</p>}
      {loading && <p style={{ color: "#6b7280" }}>Opening the office...</p>}

      <div className="ceiling-lights">
        <div className="ceiling-light" />
        <div className="ceiling-light" />
        <div className="ceiling-light" />
      </div>

      <div className="office-wall">
        <div className="bookshelf">
          <div className="shelf-row" />
          <div className="shelf-row" />
        </div>
        <div className="wall-frame" />
        <div className="window">
          <div className="window-pane" />
        </div>
        <div className="window">
          <div className="window-pane" />
        </div>
        <div className="wall-clock">
          <div className="clock-hand hour" />
          <div className="clock-hand minute" />
        </div>
      </div>

      <div className="reception-row">
        <div className="reception-desk">
          <div className="reception-logo">AI FREELANCE OS</div>
          <Character meta={{ shirt: "#0891b2", skin: "#f1c27d", hair: "#2b1b0e", style: "long" }} status="done" pose="sitting" />
        </div>

        <div className="meeting-room">
          <div className="room-label">Meeting Room</div>
          <svg viewBox="0 0 120 70" className="meeting-svg">
            <rect x="4" y="6" width="46" height="30" rx="2" fill="#ffffff" stroke="#cbd5e1" strokeWidth="1.5" />
            <rect x="9" y="10" width="14" height="9" rx="1" fill="#93c5fd" />
            <rect x="9" y="21" width="30" height="3" rx="1" fill="#e2e8f0" />
            <rect x="9" y="27" width="20" height="3" rx="1" fill="#e2e8f0" />
            <ellipse cx="80" cy="46" rx="26" ry="13" fill="#c8935f" opacity="0.9" />
            <rect x="58" y="52" width="6" height="14" rx="2" fill="#334155" />
            <rect x="96" y="52" width="6" height="14" rx="2" fill="#334155" />
            <rect x="66" y="56" width="6" height="12" rx="2" fill="#334155" />
            <rect x="88" y="56" width="6" height="12" rx="2" fill="#334155" />
          </svg>
        </div>

        <div className="lounge">
          <div className="room-label">Lounge</div>
          <svg viewBox="0 0 120 60" className="lounge-svg">
            <path d="M6,54 L6,30 Q6,22 14,22 L96,22 Q104,22 104,30 L104,54 Z" fill="#2563eb" />
            <rect x="2" y="46" width="106" height="12" rx="4" fill="#1e40af" />
            <rect x="6" y="18" width="16" height="16" rx="4" fill="#3b82f6" />
            <circle cx="70" cy="50" r="10" fill="#c8935f" />
            <circle cx="118" cy="40" r="9" fill="#38bdf8" opacity="0.6" />
            <rect x="112" y="40" width="12" height="16" rx="2" fill="#f8fafc" stroke="#94a3b8" />
          </svg>
        </div>
      </div>

      <div className={`ceo-office${ceoAlert ? " alert" : ""}`}>
        <div className="ceo-plaque">Founder</div>
        <div className="ceo-plant" />
        <Character meta={{ shirt: "#1e293b", skin: "#e0ac69", hair: "#111111", style: "short" }} status={ceoAlert ? "error" : "done"} isCeo />
        <div className="ceo-desk-top" />
        <div className="ceo-desk-front" />
        <div className={`ceo-speech${ceoAlert ? " alert" : ""}`}>{ceoMessage}</div>
      </div>

      <BreakRoom occupants={occupants} />

      <div className="office-floor">
        <div className="rug" />
        <div className="plant plant-1" />
        <div className="plant plant-2" />
        <div className="water-cooler">
          <div className="cooler-jug" />
          <div className="cooler-base" />
          {(idleAgents.filter((a) => roamingByAgent[a]?.id === "cooler")).map((agentType) => (
            <Character key={agentType} meta={AGENT_META[agentType]} status="idle" walking pose="standing" />
          ))}
        </div>

        <div className="desks-grid">
          {AGENT_ORDER.map((agentType) => (
            <Desk
              key={agentType}
              agentType={agentType}
              run={latestByAgent[agentType]}
              roaming={roamingByAgent[agentType]}
              arriving={arrivingSet.has(agentType)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
