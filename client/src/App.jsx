import { useEffect, useState } from "react";
import { api } from "./api/client.js";
import JobCard from "./components/JobCard.jsx";
import NewJobForm from "./components/NewJobForm.jsx";
import StatsBar from "./components/StatsBar.jsx";
import IncidentsPanel from "./components/IncidentsPanel.jsx";
import PerformancePanel from "./components/PerformancePanel.jsx";
import ActivityFeed from "./components/ActivityFeed.jsx";
import AdminSettings from "./components/AdminSettings.jsx";
import LeadsImport from "./components/LeadsImport.jsx";
import ClientsPanel from "./components/ClientsPanel.jsx";
import OfficeView from "./components/OfficeView.jsx";
import ProposalsPanel from "./components/ProposalsPanel.jsx";

const AUTO_REFRESH_MS = 30_000;
const TABS = ["Office", "Command Centre", "Proposals", "Jobs", "Clients", "Admin Settings"];

export default function App() {
  const [tab, setTab] = useState("Office");
  const [jobs, setJobs] = useState([]);
  const [stats, setStats] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(new Date());

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
    const interval = setInterval(refresh, AUTO_REFRESH_MS);
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => {
      clearInterval(interval);
      clearInterval(clock);
    };
  }, []);

  const needsAttention = (stats?.pendingApprovalCount || 0) + (stats?.incidents?.escalated || 0);

  return (
    <div className={`hud-shell${tab === "Office" ? " hud-shell-wide" : ""}`}>
      <div className="hud-header">
        <div>
          <h1 className="hud-title">AI Freelance OS</h1>
          <div className="hud-subtitle">
            Hunter finds + feasibility-checks jobs → Proposal Agent drafts and (where the platform
            allows) auto-sends → Worker → Delivery/QA → Payment Agent invoices. Inbox Agent reads
            client replies and the Pipeline Agent runs the rest unattended. You're only needed
            where a tile below says so.
          </div>
        </div>
        <div className="hud-clock">
          <div>
            <span className="online-dot" />
            SYSTEM ONLINE
          </div>
          <div>{now.toLocaleTimeString()}</div>
          {needsAttention > 0 && (
            <div style={{ color: "var(--accent-red)", marginTop: 4 }}>{needsAttention} item(s) need you</div>
          )}
        </div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={`tab-btn${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {error && <p style={{ color: "var(--accent-red)" }}>{error}</p>}

      {tab === "Office" && <OfficeView />}

      {tab === "Command Centre" && (
        <>
          <StatsBar stats={stats} />
          <IncidentsPanel incidents={incidents} onChanged={refresh} />
          <PerformancePanel data={stats?.performanceByCategory} />
          <ActivityFeed />
          <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
            <button className="btn" onClick={() => api.runHunter().then(refresh)}>
              Run Hunter Agent now
            </button>
            <button className="btn" onClick={() => api.runInbox().then(refresh)}>
              Check inbox now
            </button>
            <button className="btn" onClick={() => api.runPipeline().then(refresh)}>
              Advance pipeline now
            </button>
            <button className="btn" onClick={refresh}>
              Refresh
            </button>
            <a className="btn" href="/api/payments/export.csv" style={{ textDecoration: "none" }}>
              Export payments CSV
            </a>
            <button className="btn" onClick={() => api.runDigest()}>
              Send weekly digest now
            </button>
          </div>
        </>
      )}

      {tab === "Jobs" && (
        <>
          <LeadsImport onImported={refresh} />
          <NewJobForm onCreated={refresh} />
          {loading && <p style={{ color: "var(--text-dim)" }}>Loading...</p>}
          {jobs.length === 0 && !loading && (
            <p style={{ color: "var(--text-dim)" }}>No jobs yet. Add one above or run the Hunter Agent.</p>
          )}
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} onChanged={refresh} />
          ))}
        </>
      )}

      {tab === "Proposals" && <ProposalsPanel />}

      {tab === "Clients" && <ClientsPanel />}

      {tab === "Admin Settings" && <AdminSettings />}
    </div>
  );
}
