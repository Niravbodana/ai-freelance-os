import { useEffect, useState } from "react";
import { api } from "./api/client.js";
import JobCard from "./components/JobCard.jsx";
import NewJobForm from "./components/NewJobForm.jsx";
import StatsBar from "./components/StatsBar.jsx";
import IncidentsPanel from "./components/IncidentsPanel.jsx";

const AUTO_REFRESH_MS = 30_000;

export default function App() {
  const [jobs, setJobs] = useState([]);
  const [stats, setStats] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function refresh() {
    setLoading(true);
    try {
      const [jobsRes, statsRes, incidentsRes] = await Promise.all([
        api.listJobs(),
        api.stats(),
        api.listIncidents(),
      ]);
      setJobs(jobsRes);
      setStats(statsRes);
      setIncidents(incidentsRes);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // Everything here runs unattended 24x7 — the dashboard should reflect
    // that without needing a manual refresh every time you check in.
    const interval = setInterval(refresh, AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>AI Freelance OS</h1>
      <p style={{ color: "#555" }}>
        Hunter finds + feasibility-checks jobs → Proposal Agent drafts and (where the platform allows)
        auto-sends pitches → Worker Agent produces the deliverable → Delivery Agent QA-checks it →
        Payment Agent invoices and chases payment. Failures retry themselves automatically — you're
        only needed where the "Needs you" tiles below say so.
      </p>

      <StatsBar stats={stats} />
      <IncidentsPanel incidents={incidents} onChanged={refresh} />

      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <button onClick={() => api.runHunter().then(refresh)}>Run Hunter Agent now</button>
        <button onClick={refresh}>Refresh</button>
      </div>

      <NewJobForm onCreated={refresh} />

      {loading && <p>Loading...</p>}
      {error && <p style={{ color: "crimson" }}>{error}</p>}

      <h2>Jobs</h2>
      {jobs.length === 0 && !loading && <p>No jobs yet. Add one above or run the Hunter Agent.</p>}
      {jobs.map((job) => (
        <JobCard key={job.id} job={job} onChanged={refresh} />
      ))}
    </div>
  );
}
