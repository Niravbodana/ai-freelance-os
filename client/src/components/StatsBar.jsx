export default function StatsBar({ stats }) {
  if (!stats) return null;
  const s = stats.jobsByStatus || {};
  const usage = stats.claudeUsage || {};
  const rateLimit = usage.apiRateLimit;
  const incidents = stats.incidents || {};
  const inFlight =
    (s.DISCOVERED || 0) + (s.PENDING_APPROVAL || 0) + (s.PROPOSAL_SENT || 0) + (s.ACCEPTED || 0) + (s.IN_PROGRESS || 0);

  return (
    <div style={{ marginBottom: 20 }}>
      <div className="tile-grid">
        <Tile label="Needs your approval" value={stats.pendingApprovalCount} alert={stats.pendingApprovalCount > 0} />
        <Tile label="Needs you (incidents)" value={incidents.escalated} alert={incidents.escalated > 0} />
        <Tile label="Overdue payments" value={stats.overduePaymentCount} alert={stats.overduePaymentCount > 0} />
        <Tile label="Jobs in flight" value={inFlight} />
        <Tile label="Delivered" value={s.DELIVERED || 0} />
        <Tile label="Paid" value={s.PAID || 0} />
        <Tile label="Recurring clients" value={stats.recurringClients} />
        <Tile label="Revenue collected" value={`$${stats.revenue?.collected?.toFixed(0) ?? 0}`} />
        <Tile label="Revenue outstanding" value={`$${stats.revenue?.outstanding?.toFixed(0) ?? 0}`} />
      </div>

      <div className="tile-grid">
        <Tile
          label="Claude usage this month"
          value={`${((usage.inputTokensThisMonth || 0) + (usage.outputTokensThisMonth || 0)).toLocaleString()} tok`}
        />
        <Tile label="Est. cost this month" value={`$${(usage.estimatedCostThisMonth || 0).toFixed(2)}`} />
        {usage.monthlyBudgetUsd != null && (
          <Tile
            label="Budget remaining"
            value={`$${usage.budgetRemainingUsd?.toFixed(2)}`}
            alert={usage.budgetRemainingUsd < 0}
          />
        )}
        {rateLimit?.tokensRemaining != null && (
          <Tile
            label="API tokens left (this window)"
            value={`${rateLimit.tokensRemaining} / ${rateLimit.tokensLimit ?? "?"}`}
          />
        )}
        <Tile label="Auto-retrying" value={incidents.autoRetrying} />
      </div>
    </div>
  );
}

function Tile({ label, value, alert }) {
  return (
    <div className={`tile${alert ? " alert" : ""}`}>
      <div className="tile-value">{value ?? 0}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}
