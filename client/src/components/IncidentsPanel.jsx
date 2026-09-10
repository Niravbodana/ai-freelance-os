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
    <div style={{ marginBottom: 24 }}>
      {escalated.length > 0 && (
        <div style={{ border: "1px solid #c33", background: "#fdf2f2", borderRadius: 8, padding: 12, marginBottom: 8 }}>
          <strong>Needs you — {escalated.length} incident(s) exhausted automatic retries</strong>
          {escalated.map((inc) => (
            <div key={inc.id} style={{ borderTop: "1px solid #eecccc", marginTop: 8, paddingTop: 8, fontSize: 13 }}>
              <div>
                <strong>{inc.source}</strong> {inc.jobId && `· job ${inc.jobId}`} · retried {inc.retryCount}x
              </div>
              <div style={{ color: "#822", fontFamily: "monospace", fontSize: 12, margin: "4px 0" }}>{inc.message}</div>
              <button disabled={busy} onClick={() => run(() => api.resolveIncident(inc.id))}>
                Mark resolved
              </button>
            </div>
          ))}
        </div>
      )}

      {open.length > 0 && (
        <details style={{ fontSize: 13, color: "#666" }}>
          <summary>{open.length} incident(s) being auto-retried in the background</summary>
          {open.map((inc) => (
            <div key={inc.id} style={{ marginTop: 4 }}>
              {inc.source} {inc.jobId && `· job ${inc.jobId}`} · attempt {inc.retryCount}/{inc.maxRetries}
            </div>
          ))}
          <button disabled={busy} onClick={() => run(() => api.retryIncidentsNow())} style={{ marginTop: 8 }}>
            Retry now
          </button>
        </details>
      )}
    </div>
  );
}
