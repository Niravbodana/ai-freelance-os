/**
 * What's actually winning, by category — the same data the Proposal Agent
 * feeds into its own prompt to calibrate rate/pitch (see
 * services/performance.js). Shown here so it's not a black box: you can
 * see exactly what the AI is learning from.
 */
export default function PerformancePanel({ data }) {
  if (!data || data.length === 0) return null;

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 24 }}>
      <strong style={{ fontSize: 14 }}>Proposal performance by category</strong>
      <table style={{ width: "100%", fontSize: 13, marginTop: 8, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#666" }}>
            <th style={{ padding: "4px 8px 4px 0" }}>Category</th>
            <th style={{ padding: "4px 8px" }}>Sent (with outcome)</th>
            <th style={{ padding: "4px 8px" }}>Accepted</th>
            <th style={{ padding: "4px 8px" }}>Win rate</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.category}>
              <td style={{ padding: "4px 8px 4px 0" }}>{row.category}</td>
              <td style={{ padding: "4px 8px" }}>{row.total}</td>
              <td style={{ padding: "4px 8px" }}>{row.accepted}</td>
              <td style={{ padding: "4px 8px" }}>{row.winRate}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
