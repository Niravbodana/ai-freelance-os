/**
 * What's actually winning, by category — the same data the Proposal Agent
 * feeds into its own prompt to calibrate rate/pitch (see
 * services/performance.js). Shown here so it's not a black box: you can
 * see exactly what the AI is learning from.
 */
export default function PerformancePanel({ data }) {
  if (!data || data.length === 0) return null;

  return (
    <div className="panel" style={{ marginBottom: 20 }}>
      <div className="settings-group-title" style={{ marginTop: 0 }}>
        Proposal Performance by Category
      </div>
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", color: "var(--text)" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-dim)" }}>
            <th style={{ padding: "4px 8px 4px 0" }}>Category</th>
            <th style={{ padding: "4px 8px" }}>Sent (with outcome)</th>
            <th style={{ padding: "4px 8px" }}>Accepted</th>
            <th style={{ padding: "4px 8px" }}>Win rate</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.category} style={{ borderTop: "1px solid var(--border)" }}>
              <td style={{ padding: "4px 8px 4px 0" }}>{row.category}</td>
              <td style={{ padding: "4px 8px" }}>{row.total}</td>
              <td style={{ padding: "4px 8px" }}>{row.accepted}</td>
              <td style={{ padding: "4px 8px", color: "var(--accent)" }}>{row.winRate}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
