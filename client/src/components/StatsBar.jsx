const TILE_STYLE = { flex: "1 1 140px", border: "1px solid #ddd", borderRadius: 8, padding: 12 };

export default function StatsBar({ stats }) {
  if (!stats) return null;
  const s = stats.jobsByStatus || {};
  const inFlight =
    (s.DISCOVERED || 0) + (s.PENDING_APPROVAL || 0) + (s.PROPOSAL_SENT || 0) + (s.ACCEPTED || 0) + (s.IN_PROGRESS || 0);

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}>
      <Tile label="Needs your approval" value={stats.pendingApprovalCount} highlight={stats.pendingApprovalCount > 0} />
      <Tile label="Overdue payments" value={stats.overduePaymentCount} highlight={stats.overduePaymentCount > 0} />
      <Tile label="Jobs in flight" value={inFlight} />
      <Tile label="Delivered" value={s.DELIVERED || 0} />
      <Tile label="Paid" value={s.PAID || 0} />
      <Tile label="Recurring clients" value={stats.recurringClients} />
      <Tile label="Revenue collected" value={`$${stats.revenue?.collected?.toFixed(0) ?? 0}`} />
      <Tile label="Revenue outstanding" value={`$${stats.revenue?.outstanding?.toFixed(0) ?? 0}`} />
    </div>
  );
}

function Tile({ label, value, highlight }) {
  return (
    <div style={{ ...TILE_STYLE, borderColor: highlight ? "#c33" : "#ddd", background: highlight ? "#fdf2f2" : "white" }}>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{value ?? 0}</div>
      <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
    </div>
  );
}
