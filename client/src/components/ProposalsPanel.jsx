import { useEffect, useState } from "react";
import { api } from "../api/client.js";

function group(proposals) {
  const needsApproval = [];
  const sent = [];
  const accepted = [];
  const closed = [];
  for (const p of proposals) {
    if (!p.approved) needsApproval.push(p);
    else if (p.outcome === "ACCEPTED") accepted.push(p);
    else if (p.outcome === "REJECTED" || p.outcome === "COUNTER_OFFER") closed.push(p);
    else sent.push(p);
  }
  return { needsApproval, sent, accepted, closed };
}

function ProposalCard({ proposal, onChanged, editable }) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState(proposal.editedText ?? proposal.draftText);
  const job = proposal.job;

  async function run(action) {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (err) {
      alert(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="job-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="job-title">{job?.title}</span>
        <span className="pill">{job?.status}</span>
      </div>
      <div className="job-meta">
        {job?.category} · {job?.source}
        {proposal.proposedRate && (
          <>
            {" · rate: "}
            <strong style={{ color: "var(--text)" }}>{proposal.proposedRate}</strong>
          </>
        )}
        {proposal.autoSent && <span style={{ color: "var(--accent-green)", marginLeft: 8 }}>auto-sent</span>}
        {job?.statusToken && (
          <>
            {" · "}
            <a href={`/status/${job.statusToken}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
              client status link
            </a>
          </>
        )}
      </div>

      {editable ? (
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} style={{ width: "100%", marginBottom: 8 }} />
      ) : (
        <pre
          style={{
            whiteSpace: "pre-wrap",
            background: "var(--bg-raised)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: 10,
            fontSize: 12,
            color: "var(--text-dim)",
          }}
        >
          {proposal.editedText || proposal.draftText}
        </pre>
      )}

      {proposal.negotiationLog && (
        <p style={{ fontSize: 12, color: "var(--accent-amber)" }}>{proposal.negotiationLog}</p>
      )}
      {proposal.outcome && (
        <p style={{ fontSize: 12, color: proposal.outcome === "ACCEPTED" ? "var(--accent-green)" : "var(--accent-red)" }}>
          Outcome: {proposal.outcome}
        </p>
      )}

      {editable && (
        <div style={{ marginTop: 8 }}>
          <button
            className="btn success"
            disabled={busy}
            onClick={() => run(() => api.approveProposalById(job.id, text))}
          >
            Approve &amp; send
          </button>{" "}
          <button className="btn danger" disabled={busy} onClick={() => run(() => api.rejectProposalById(job.id))}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

export default function ProposalsPanel() {
  const [proposals, setProposals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    try {
      setProposals(await api.listProposals());
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, []);

  const { needsApproval, sent, accepted, closed } = group(proposals);

  return (
    <div>
      <div className="tile-grid">
        <div className={`tile${needsApproval.length > 0 ? " alert" : ""}`}>
          <div className="tile-value">{needsApproval.length}</div>
          <div className="tile-label">Needs your approval</div>
        </div>
        <div className="tile">
          <div className="tile-value">{sent.length}</div>
          <div className="tile-label">Sent — awaiting reply</div>
        </div>
        <div className="tile">
          <div className="tile-value" style={{ color: "var(--accent-green)" }}>{accepted.length}</div>
          <div className="tile-label">Accepted</div>
        </div>
        <div className="tile">
          <div className="tile-value">{closed.length}</div>
          <div className="tile-label">Rejected / countered</div>
        </div>
      </div>

      {error && <p style={{ color: "var(--accent-red)" }}>{error}</p>}
      {loading && <p style={{ color: "var(--text-dim)" }}>Loading...</p>}

      {needsApproval.length > 0 && (
        <>
          <div className="settings-group-title">Needs your approval</div>
          {needsApproval.map((p) => (
            <ProposalCard key={p.id} proposal={p} onChanged={load} editable />
          ))}
        </>
      )}

      {sent.length > 0 && (
        <>
          <div className="settings-group-title">Sent — awaiting reply</div>
          {sent.map((p) => (
            <ProposalCard key={p.id} proposal={p} onChanged={load} />
          ))}
        </>
      )}

      {accepted.length > 0 && (
        <>
          <div className="settings-group-title">Accepted</div>
          {accepted.map((p) => (
            <ProposalCard key={p.id} proposal={p} onChanged={load} />
          ))}
        </>
      )}

      {closed.length > 0 && (
        <>
          <div className="settings-group-title">Rejected / countered</div>
          {closed.map((p) => (
            <ProposalCard key={p.id} proposal={p} onChanged={load} />
          ))}
        </>
      )}

      {!loading && proposals.length === 0 && (
        <p style={{ color: "var(--text-dim)" }}>No proposals yet — Hunter Agent drafts these automatically once a feasible job is found.</p>
      )}
    </div>
  );
}
