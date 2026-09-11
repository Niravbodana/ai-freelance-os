import { useEffect, useState } from "react";
import { api } from "../api/client.js";

const JOB_STATUS_PILL = {
  NOT_FEASIBLE: "bad",
  REJECTED: "bad",
  DELIVERED: "ok",
  PAID: "ok",
  AWAITING_PAYMENT: "warn",
  PENDING_APPROVAL: "warn",
};

const PAYMENT_STATUS_PILL = {
  PAID: "ok",
  OVERDUE: "bad",
  INVOICE_SENT: "warn",
  PENDING: "",
};

function money(amount, currency = "USD") {
  return `${currency} ${Number(amount || 0).toFixed(2)}`;
}

export default function ClientsPanel() {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(new Set());

  async function load() {
    setLoading(true);
    try {
      setClients(await api.listClients());
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function toggle(id) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const totalReceived = clients.reduce((sum, c) => sum + c.financials.received, 0);
  const totalRemaining = clients.reduce((sum, c) => sum + c.financials.remaining, 0);
  const totalAiCost = clients.reduce((sum, c) => sum + (c.financials.aiCost || 0), 0);
  const totalProfit = totalReceived - totalAiCost;

  return (
    <div>
      <div className="tile-grid">
        <div className="tile">
          <div className="tile-value">{clients.length}</div>
          <div className="tile-label">Total clients</div>
        </div>
        <div className="tile">
          <div className="tile-value">{clients.filter((c) => c.isRecurring).length}</div>
          <div className="tile-label">Recurring</div>
        </div>
        <div className="tile">
          <div className="tile-value" style={{ color: "var(--accent-green)" }}>
            {money(totalReceived)}
          </div>
          <div className="tile-label">Received (all clients)</div>
        </div>
        <div className={`tile${totalRemaining > 0 ? " alert" : ""}`}>
          <div className="tile-value">{money(totalRemaining)}</div>
          <div className="tile-label">Remaining / outstanding</div>
        </div>
        <div className="tile">
          <div className="tile-value" style={{ color: totalProfit >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
            {money(totalProfit)}
          </div>
          <div className="tile-label">Real profit (received − AI cost, {money(totalAiCost)} spent)</div>
        </div>
      </div>

      {error && <p style={{ color: "var(--accent-red)" }}>{error}</p>}
      {loading && <p style={{ color: "var(--text-dim)" }}>Loading...</p>}
      {!loading && clients.length === 0 && (
        <p style={{ color: "var(--text-dim)" }}>
          No clients yet — one gets created automatically the first time a job has an apply-email
          (job-board reply address, outreach lead, or a client email you enter on a manual job).
        </p>
      )}

      {clients.map((client) => {
        const isOpen = expanded.has(client.id);
        return (
          <div key={client.id} className="panel" style={{ marginBottom: 10, borderLeft: "3px solid var(--accent)" }}>
            <div
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
              onClick={() => toggle(client.id)}
            >
              <div>
                <span className="job-title" style={{ fontFamily: "var(--font-display)", fontSize: 13 }}>
                  {client.name}
                </span>
                {client.isRecurring && (
                  <span style={{ color: "var(--accent-green)", marginLeft: 8, fontSize: 11 }}>★ recurring</span>
                )}
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
                  {client.email || "no email on file"} · {client.platform}
                </div>
              </div>
              <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>received</div>
                  <div style={{ color: "var(--accent-green)", fontSize: 13 }}>{money(client.financials.received)}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>remaining</div>
                  <div style={{ color: client.financials.remaining > 0 ? "var(--accent-amber)" : "var(--text-dim)", fontSize: 13 }}>
                    {money(client.financials.remaining)}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>profit</div>
                  <div style={{ color: client.financials.profit >= 0 ? "var(--accent-green)" : "var(--accent-red)", fontSize: 13 }}>
                    {money(client.financials.profit)}
                  </div>
                </div>
                <span className="pill">{client.jobCount} job{client.jobCount === 1 ? "" : "s"}</span>
                <span style={{ color: "var(--text-dim)" }}>{isOpen ? "▲" : "▼"}</span>
              </div>
            </div>

            {isOpen && (
              <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                {client.jobs.length === 0 && <p style={{ color: "var(--text-dim)", fontSize: 12 }}>No jobs yet.</p>}
                {client.jobs.map((job) => (
                  <div
                    key={job.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                      gap: 8,
                      padding: "8px 0",
                      borderBottom: "1px solid rgba(56, 214, 255, 0.08)",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 12, color: "var(--text)" }}>{job.title}</div>
                      <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                        {job.category} · {job.source}
                        {job.statusToken && (
                          <>
                            {" · "}
                            <a href={`/status/${job.statusToken}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                              client status link
                            </a>
                          </>
                        )}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <span className={`pill ${JOB_STATUS_PILL[job.status] || ""}`}>{job.status}</span>
                      {job.payments.map((p) => (
                        <span key={p.kind} className={`pill ${PAYMENT_STATUS_PILL[p.status] || ""}`}>
                          {p.kind} {money(p.amount, p.currency)} — {p.status}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
