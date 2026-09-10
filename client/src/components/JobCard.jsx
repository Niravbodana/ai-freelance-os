import { useState } from "react";
import { api } from "../api/client.js";

export default function JobCard({ job, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [editedText, setEditedText] = useState(job.proposal?.draftText ?? "");

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
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 16, marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong>{job.title}</strong>
        <span style={{ fontSize: 12, color: "#666" }}>{job.status}</span>
      </div>
      <p style={{ color: "#555", fontSize: 14 }}>{job.description}</p>
      <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>
        {job.category} · {job.source} · {job.budget || "no budget listed"}
        {job.client?.isRecurring && <span style={{ color: "#0a7", marginLeft: 8 }}>★ recurring client</span>}
      </div>

      {job.status === "NOT_FEASIBLE" && (
        <p style={{ fontSize: 13, color: "#a33" }}>
          Skipped — not something we can reliably deliver. Reason: {job.feasibilityNote}
        </p>
      )}

      {job.status === "DISCOVERED" && (
        <button disabled={busy} onClick={() => run(() => api.draftProposal(job.id))}>
          Draft proposal
        </button>
      )}

      {job.status === "PENDING_APPROVAL" && job.proposal && (
        <div>
          {job.proposal.proposedRate && (
            <p style={{ fontSize: 13 }}>Proposed rate: <strong>{job.proposal.proposedRate}</strong></p>
          )}
          <textarea
            value={editedText}
            onChange={(e) => setEditedText(e.target.value)}
            rows={5}
            style={{ width: "100%", padding: 6, marginBottom: 8 }}
          />
          <button disabled={busy} onClick={() => run(() => api.approveProposal(job.id, editedText))}>
            Approve & send
          </button>
        </div>
      )}

      {job.status === "PROPOSAL_SENT" && (
        <div>
          <p style={{ fontSize: 13 }}>
            {job.proposal?.autoSent ? "Auto-sent." : "Sent — waiting on client reply."}
            {job.applyEmail
              ? " The Inbox Agent will detect their reply automatically."
              : " This source has no email thread to auto-detect — use the buttons below once you hear back."}
          </p>
          {job.proposal?.negotiationLog?.startsWith("Client countered") && (
            <p style={{ fontSize: 13, color: "#a60" }}>{job.proposal.negotiationLog}</p>
          )}
          <button disabled={busy} onClick={() => run(() => api.markAccepted(job.id))}>
            Mark accepted
          </button>{" "}
          <button disabled={busy} onClick={() => run(() => api.markRejected(job.id))}>
            Mark rejected
          </button>
        </div>
      )}

      {(job.status === "ACCEPTED" || job.status === "IN_PROGRESS") && (
        <div>
          {!job.deliverable && (
            <button disabled={busy} onClick={() => run(() => api.runWorker(job.id))}>
              Run Worker Agent
            </button>
          )}
          {job.deliverable && !job.deliverable.qaPassed && (
            <button disabled={busy} onClick={() => run(() => api.runDelivery(job.id))}>
              Run Delivery/QA Agent
            </button>
          )}
          {job.deliverable && (
            <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 8, marginTop: 8 }}>
              {job.deliverable.content}
            </pre>
          )}
        </div>
      )}

      {job.status === "DELIVERED" && !job.payment && (
        <div>
          <p style={{ color: "green", fontSize: 13 }}>Delivered ✓ QA passed. Ready to invoice.</p>
          <button disabled={busy} onClick={() => run(() => api.invoiceJob(job.id))}>
            Send invoice
          </button>
        </div>
      )}

      {job.status === "AWAITING_PAYMENT" && job.payment && (
        <div>
          <p style={{ fontSize: 13 }}>
            Invoiced {job.payment.amount} {job.payment.currency} via {job.payment.provider}
            {job.payment.status === "OVERDUE" && <span style={{ color: "#a33" }}> — overdue, reminder sent</span>}
          </p>
          {job.payment.invoiceUrl && (
            <a href={job.payment.invoiceUrl} target="_blank" rel="noreferrer">
              View invoice
            </a>
          )}
          <div>
            <button disabled={busy} onClick={() => run(() => api.markPaid(job.id))}>
              Mark paid
            </button>
          </div>
        </div>
      )}

      {job.status === "PAID" && <p style={{ color: "green", fontSize: 13 }}>Paid ✓</p>}
    </div>
  );
}
