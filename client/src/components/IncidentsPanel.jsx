import { useState } from "react";
import { api } from "../api/client.js";

/**
 * The "where do you actually need to step in" panel. ESCALATED incidents
 * exhausted their automatic retries — those are the only ones that need a
 * decision from you. OPEN ones are still being retried unattended, shown
 * just so the self-healing loop isn't a black box.
 */
export default function IncidentsPanel({ incidents, onChanged }) {
  const [busy, setBusy] = useState(false);
  if (!incidents || incidents.length === 0) return null;

  const escalated = incidents.filter((i) => i.status === "ESCALATED");
  const open = incidents.filter((i) => i.status === "OPEN");

  async function run(action) {
    setBusy(true);
    try {
      await action();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: 20 }}>
      {escalated.length > 0 && (
        <div className="panel" style={{ borderColor: "var(--accent-red)", background: "var(--accent-red-soft)", marginBottom: 8 }}>
          <strong style={{ color: "var(--accent-red)", fontFamily: "var(--font-display)", fontSize: 12 }}>
            NEEDS YOU — {escalated.length} incident(s) exhausted automatic retries
          </strong>
          {escalated.map((inc) => (
            <div key={inc.id} style={{ borderTop: "1px solid rgba(255,77,106,0.25)", marginTop: 8, paddingTop: 8, fontSize: 12 }}>
              <div style={{ color: "var(--text)" }}>
                <strong>{inc.source}</strong> {inc.jobId && `· job ${inc.jobId}`} · retried {inc.retryCount}x
              </div>
              <div style={{ color: "var(--accent-red)", margin: "4px 0" }}>{inc.message}</div>
              <button className="btn" disabled={busy} onClick={() => run(() => api.resolveIncident(inc.id))}>
                Mark resolved
              </button>
            </div>
          ))}
        </div>
      )}

      {open.length > 0 && (
        <details className="panel" style={{ fontSize: 12, color: "var(--text-dim)" }}>
          <summary>{open.length} incident(s) being auto-retried in the background</summary>
          {open.map((inc) => (
            <div key={inc.id} style={{ marginTop: 4 }}>
              {inc.source} {inc.jobId && `· job ${inc.jobId}`} · attempt {inc.retryCount}/{inc.maxRetries}
            </div>
          ))}
          <button className="btn" disabled={busy} onClick={() => run(() => api.retryIncidentsNow())} style={{ marginTop: 8 }}>
            Retry now
          </button>
        </details>
      )}
    </div>
  );
}
