import { useEffect, useState } from "react";
import { api } from "./api/client.js";
import JobCard from "./components/JobCard.jsx";
import NewJobForm from "./components/NewJobForm.jsx";
import StatsBar from "./components/StatsBar.jsx";

export default function App() {
  const [jobs, setJobs] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function refresh() {
    setLoading(true);
    try {
      const [jobsRes, statsRes] = await Promise.all([api.listJobs(), api.stats()]);
      setJobs(jobsRes);
      setStats(statsRes);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>AI Freelance OS</h1>
      <p style={{ color: "#555" }}>
        Hunter finds + feasibility-checks jobs → Proposal Agent drafts and (where the platform allows)
        auto-sends pitches → Worker Agent produces the deliverable → Delivery Agent QA-checks it →
        Payment Agent invoices and chases payment.
      </p>

      <StatsBar stats={stats} />

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
