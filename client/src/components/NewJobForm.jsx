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
    <form onSubmit={submit} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 16, marginBottom: 24 }}>
      <h3 style={{ marginTop: 0 }}>Add a job (Upwork copy-paste or outreach lead)</h3>
      <input
        placeholder="Title"
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
        required
        style={{ width: "100%", marginBottom: 8, padding: 6 }}
      />
      <textarea
        placeholder="Description / brief"
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
        required
        rows={4}
        style={{ width: "100%", marginBottom: 8, padding: 6 }}
      />
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input
          placeholder="Budget"
          value={form.budget}
          onChange={(e) => setForm({ ...form, budget: e.target.value })}
          style={{ flex: 1, padding: 6 }}
        />
        <select
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
          style={{ flex: 1, padding: 6 }}
        >
          <option value="content">content</option>
          <option value="data">data</option>
          <option value="code">code</option>
          <option value="other">other</option>
        </select>
        <select
          value={form.source}
          onChange={(e) => setForm({ ...form, source: e.target.value })}
          style={{ flex: 1, padding: 6 }}
        >
          <option value="MANUAL">manual</option>
          <option value="UPWORK">upwork</option>
          <option value="OUTREACH">outreach</option>
        </select>
      </div>
      <button type="submit" disabled={submitting}>
        {submitting ? "Adding..." : "Add job"}
      </button>
    </form>
  );
}
