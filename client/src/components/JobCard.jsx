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
      </div>

      {job.status === "DISCOVERED" && (
        <button disabled={busy} onClick={() => run(() => api.draftProposal(job.id))}>
          Draft proposal
        </button>
      )}

      {job.status === "PENDING_APPROVAL" && job.proposal && (
        <div>
          <textarea
            value={editedText}
            onChange={(e) => setEditedText(e.target.value)}
            rows={5}
            style={{ width: "100%", padding: 6, marginBottom: 8 }}
          />
          <button disabled={busy} onClick={() => run(() => api.approveProposal(job.id, editedText))}>
            Approve & mark sent
          </button>
        </div>
      )}

      {job.status === "PROPOSAL_SENT" && (
        <p style={{ fontSize: 13 }}>Waiting on client acceptance — flip to ACCEPTED manually once they reply.</p>
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

      {job.status === "DELIVERED" && <p style={{ color: "green", fontSize: 13 }}>Delivered ✓ QA passed.</p>}
    </div>
  );
}
