import { useEffect, useState } from "react";
import { api } from "./api/client.js";
import JobCard from "./components/JobCard.jsx";
import NewJobForm from "./components/NewJobForm.jsx";

export default function App() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function refresh() {
    setLoading(true);
    try {
      setJobs(await api.listJobs());
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
        Hunter finds jobs → Proposal Agent drafts pitches (you approve before send) → Worker
        Agent produces the deliverable → Delivery Agent QA-checks it.
      </p>

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
