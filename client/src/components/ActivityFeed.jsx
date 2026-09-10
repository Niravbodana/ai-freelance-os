import { useEffect, useState } from "react";
import { api } from "../api/client.js";

const POLL_MS = 8_000;

/**
 * "Kaam hota hua dikhna chahiye" — a terminal-style live feed of every
 * agent run (Hunter, Feasibility, Proposal, Worker, Delivery, Payment,
 * Inbox, Pipeline), newest first, polling independently of the rest of
 * the dashboard so it keeps scrolling even if you're looking at Jobs/Admin.
 */
export default function ActivityFeed() {
  const [runs, setRuns] = useState([]);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await api.listRuns();
        if (!cancelled) setRuns(data);
      } catch {
        // Transient failures just skip a refresh — feed still shows last known state.
      }
    }
    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="panel panel-glow" style={{ marginBottom: 20 }}>
      <div className="settings-group-title" style={{ marginTop: 0 }}>
        Live Agent Activity
      </div>
      <div className="feed">
        {runs.length === 0 && <div style={{ color: "var(--text-dimmer)" }}>No activity yet.</div>}
        {runs.map((run) => (
          <div className="feed-row" key={run.id}>
            <span className="feed-time">{formatTime(run.startedAt)}</span>
            <span className="feed-agent">{run.agent}</span>
            <span className={`feed-status ${run.status}`}>{run.status}</span>
            <span className="feed-detail">{run.job?.title || run.log || ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
