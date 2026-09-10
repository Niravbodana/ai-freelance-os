import { useState } from "react";
import { api } from "../api/client.js";

const EMPTY = { title: "", description: "", budget: "", category: "content", source: "MANUAL" };

export default function NewJobForm({ onCreated }) {
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.createJob(form);
      setForm(EMPTY);
      onCreated();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel" style={{ marginBottom: 20 }}>
      <div className="settings-group-title" style={{ marginTop: 0 }}>
        Add a job (Upwork copy-paste or outreach lead)
      </div>
      <input
        placeholder="Title"
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
        required
        style={{ width: "100%", marginBottom: 8 }}
      />
      <textarea
        placeholder="Description / brief"
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
        required
        rows={4}
        style={{ width: "100%", marginBottom: 8 }}
      />
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <input
          placeholder="Budget"
          value={form.budget}
          onChange={(e) => setForm({ ...form, budget: e.target.value })}
          style={{ flex: "1 1 120px" }}
        />
        <select
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
          style={{ flex: "1 1 120px" }}
        >
          <option value="content">content</option>
          <option value="data">data</option>
          <option value="code">code</option>
          <option value="other">other</option>
        </select>
        <select
          value={form.source}
          onChange={(e) => setForm({ ...form, source: e.target.value })}
          style={{ flex: "1 1 120px" }}
        >
          <option value="MANUAL">manual</option>
          <option value="UPWORK">upwork</option>
          <option value="OUTREACH">outreach</option>
        </select>
      </div>
      <button type="submit" className="btn" disabled={submitting}>
        {submitting ? "Adding..." : "Add job"}
      </button>
    </form>
  );
}
