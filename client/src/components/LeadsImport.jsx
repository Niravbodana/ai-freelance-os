import { useState } from "react";
import { api } from "../api/client.js";

/**
 * Turns a lead list YOU curate (LinkedIn export, a purchased B2B list,
 * companies you've noticed could use the work) into automated,
 * personalized outreach. This deliberately does not go find leads on its
 * own — who's a relevant, consensual target is your call; this automates
 * everything after that: drafting a personalized pitch per lead and
 * sending it (outreach auto-sends, same as everywhere else in this app).
 */
export default function LeadsImport({ onImported }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);

  function parseLeads() {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [companyName, contactEmail, ...noteParts] = line.split(",").map((s) => s.trim());
        return { companyName, contactEmail, note: noteParts.join(",").trim() || undefined };
      })
      .filter((l) => l.companyName && l.contactEmail);
  }

  async function submit() {
    const leads = parseLeads();
    if (leads.length === 0) return;
    setBusy(true);
    setResults(null);
    try {
      const res = await api.importLeads(leads);
      setResults(res.results);
      setText("");
      onImported?.();
    } catch (err) {
      alert(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ marginBottom: 20 }}>
      <div className="settings-group-title" style={{ marginTop: 0 }}>
        Bulk Outreach Import
      </div>
      <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 0 }}>
        One lead per line: <code>Company Name, contact@email.com, optional note about what they need</code>.
        Each one gets a feasibility check, a personalized proposal, and (since outreach auto-sends) an
        actual email — no per-lead approval needed.
      </p>
      <textarea
        rows={5}
        style={{ width: "100%", marginBottom: 8 }}
        placeholder={"Acme Blog Co, editor@acmeblog.com, Looking for weekly blog content\nBrightPath Marketing, hello@brightpath.io"}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button className="btn" disabled={busy || !text.trim()} onClick={submit}>
        {busy ? "Importing..." : "Import & send outreach"}
      </button>

      {results && (
        <div style={{ marginTop: 10, fontSize: 12 }}>
          {results.map((r, i) => (
            <div key={i} style={{ color: r.error ? "var(--accent-red)" : "var(--text-dim)" }}>
              {r.companyName}: {r.error ? r.error : r.feasible ? "sent ✓" : `skipped (${r.feasibilityNote || "not feasible"})`}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
