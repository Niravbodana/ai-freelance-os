const BASE = "/api";

async function request(path, options) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export const api = {
  listJobs: (status) => request(`/jobs${status ? `?status=${status}` : ""}`),
  createJob: (job) => request("/jobs", { method: "POST", body: JSON.stringify(job) }),
  draftProposal: (id) => request(`/jobs/${id}/draft-proposal`, { method: "POST" }),
  approveProposal: (id, editedText) =>
    request(`/jobs/${id}/approve-proposal`, { method: "POST", body: JSON.stringify({ editedText }) }),
  runWorker: (id) => request(`/jobs/${id}/run-worker`, { method: "POST" }),
  runDelivery: (id) => request(`/jobs/${id}/run-delivery`, { method: "POST" }),
  invoiceJob: (id, body) => request(`/jobs/${id}/invoice`, { method: "POST", body: JSON.stringify(body || {}) }),
  markPaid: (id, kind = "FINAL") => request(`/jobs/${id}/mark-paid`, { method: "POST", body: JSON.stringify({ kind }) }),
  markAccepted: (id) => request(`/jobs/${id}/mark-accepted`, { method: "POST" }),
  markRejected: (id) => request(`/jobs/${id}/mark-rejected`, { method: "POST" }),
  runHunter: () => request(`/agents/hunter/run`, { method: "POST" }),
  runInbox: () => request(`/agents/inbox/run`, { method: "POST" }),
  runPipeline: () => request(`/agents/pipeline/run`, { method: "POST" }),
  runDigest: () => request(`/agents/digest/run`, { method: "POST" }),
  listRuns: () => request(`/agents/runs`),
  stats: () => request(`/stats`),
  listIncidents: (status) => request(`/incidents${status ? `?status=${status}` : ""}`),
  resolveIncident: (id) => request(`/incidents/${id}/resolve`, { method: "POST" }),
  retryIncidentsNow: () => request(`/incidents/retry-now`, { method: "POST" }),
  getSettings: () => request(`/admin/settings`),
  saveSettings: (values) => request(`/admin/settings`, { method: "POST", body: JSON.stringify(values) }),
  clearSetting: (key) => request(`/admin/settings/${key}/clear`, { method: "POST" }),
  testSetting: (key) => request(`/admin/settings/${key}/test`, { method: "POST" }),
  importLeads: (leads) => request(`/leads/bulk-import`, { method: "POST", body: JSON.stringify({ leads }) }),
  getSettingsBackup: () => request(`/admin/settings/backup`),
  restoreSettingsBackup: (backup) => request(`/admin/settings/restore`, { method: "POST", body: JSON.stringify(backup) }),
};
