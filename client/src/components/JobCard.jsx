import { useState } from "react";
import { api } from "../api/client.js";

const STATUS_PILL_CLASS = {
  NOT_FEASIBLE: "bad",
  DELIVERED: "ok",
  PAID: "ok",
  AWAITING_PAYMENT: "warn",
  PENDING_APPROVAL: "warn",
};

export default function JobCard({ job, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [editedText, setEditedText] = useState(job.proposal?.draftText ?? "");
  const deposit = job.payments?.find((p) => p.kind === "DEPOSIT");
  const finalPayment = job.payments?.find((p) => p.kind === "FINAL");

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
        <span className="job-title">{job.title}</span>
        <span className={`pill ${STATUS_PILL_CLASS[job.status] || ""}`}>{job.status}</span>
      </div>
      <p className="job-desc">{job.description}</p>
      <div className="job-meta">
        {job.category} · {job.source} · {job.budget || "no budget listed"}
        {job.client?.isRecurring && <span style={{ color: "var(--accent-green)", marginLeft: 8 }}>★ recurring client</span>}
        {job.statusToken && (
          <>
            {" · "}
            <a
              href={`/status/${job.statusToken}`}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)" }}
            >
              client status link
            </a>
          </>
        )}
      </div>

      {job.status === "NOT_FEASIBLE" && (
        <p style={{ fontSize: 12, color: "var(--accent-red)" }}>
          Skipped — not something we can reliably deliver. Reason: {job.feasibilityNote}
        </p>
      )}

      {job.status === "DISCOVERED" && (
        <button className="btn" disabled={busy} onClick={() => run(() => api.draftProposal(job.id))}>
          Draft proposal
        </button>
      )}

      {job.status === "PENDING_APPROVAL" && job.proposal && (
        <div>
          {job.proposal.proposedRate && (
            <p style={{ fontSize: 12, color: "var(--text-dim)" }}>
              Proposed rate: <strong style={{ color: "var(--text)" }}>{job.proposal.proposedRate}</strong>
            </p>
          )}
          <textarea
            value={editedText}
            onChange={(e) => setEditedText(e.target.value)}
            rows={5}
            style={{ width: "100%", marginBottom: 8 }}
          />
          <button className="btn success" disabled={busy} onClick={() => run(() => api.approveProposal(job.id, editedText))}>
            Approve &amp; send
          </button>
        </div>
      )}

      {job.status === "PROPOSAL_SENT" && (
        <div>
          <p style={{ fontSize: 12, color: "var(--text-dim)" }}>
            {job.proposal?.autoSent ? "Auto-sent." : "Sent — waiting on client reply."}
            {job.applyEmail
              ? " The Inbox Agent will detect their reply automatically."
              : " This source has no email thread to auto-detect — use the buttons below once you hear back."}
          </p>
          {job.proposal?.negotiationLog?.startsWith("Client countered") && (
            <p style={{ fontSize: 12, color: "var(--accent-amber)" }}>{job.proposal.negotiationLog}</p>
          )}
          <button className="btn success" disabled={busy} onClick={() => run(() => api.markAccepted(job.id))}>
            Mark accepted
          </button>{" "}
          <button className="btn danger" disabled={busy} onClick={() => run(() => api.markRejected(job.id))}>
            Mark rejected
          </button>
        </div>
      )}

      {job.status === "ACCEPTED" && deposit && deposit.status !== "PAID" && (
        <div style={{ marginBottom: 8 }}>
          <p style={{ fontSize: 12, color: "var(--accent-amber)" }}>
            First-time client — a {deposit.amount} {deposit.currency} deposit was invoiced automatically.
            Worker Agent holds off until it's marked paid.
          </p>
          {deposit.invoiceUrl && (
            <a href={deposit.invoiceUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
              View deposit invoice
            </a>
          )}{" "}
          <button className="btn success" disabled={busy} onClick={() => run(() => api.markPaid(job.id, "DEPOSIT"))}>
            Mark deposit paid
          </button>
        </div>
      )}

      {(job.status === "ACCEPTED" || job.status === "IN_PROGRESS") && (
        <div>
          {!job.deliverable && (
            <button className="btn" disabled={busy} onClick={() => run(() => api.runWorker(job.id))}>
              Run Worker Agent
            </button>
          )}
          {job.deliverable && !job.deliverable.qaPassed && (
            <button className="btn" disabled={busy} onClick={() => run(() => api.runDelivery(job.id))}>
              Run Delivery/QA Agent
            </button>
          )}
          {job.deliverable && (
            <pre
              style={{
                whiteSpace: "pre-wrap",
                background: "var(--bg-raised)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: 10,
                marginTop: 8,
                fontSize: 12,
                color: "var(--text-dim)",
              }}
            >
              {job.deliverable.content}
            </pre>
          )}
        </div>
      )}

      {job.status === "DELIVERED" && !finalPayment && (
        <div>
          <p style={{ color: "var(--accent-green)", fontSize: 12 }}>Delivered ✓ QA passed. Ready to invoice.</p>
          <button className="btn" disabled={busy} onClick={() => run(() => api.invoiceJob(job.id))}>
            Send invoice
          </button>
        </div>
      )}

      {job.status === "AWAITING_PAYMENT" && finalPayment && (
        <div>
          <p style={{ fontSize: 12, color: "var(--text-dim)" }}>
            Invoiced {finalPayment.amount} {finalPayment.currency} via {finalPayment.provider}
            {deposit?.status === "PAID" && " (after deposit)"}
            {finalPayment.status === "OVERDUE" && <span style={{ color: "var(--accent-red)" }}> — overdue, reminder sent</span>}
          </p>
          {finalPayment.invoiceUrl && (
            <a href={finalPayment.invoiceUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
              View invoice
            </a>
          )}
          <div style={{ marginTop: 6 }}>
            <button className="btn success" disabled={busy} onClick={() => run(() => api.markPaid(job.id, "FINAL"))}>
              Mark paid
            </button>
          </div>
        </div>
      )}

      {job.status === "PAID" && <p style={{ color: "var(--accent-green)", fontSize: 12 }}>Paid ✓</p>}
    </div>
  );
}
