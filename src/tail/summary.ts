import type { TailTradeRow } from "./db.js";

export interface TailSummary {
  tradeCount: number; // closed trades only -- the ones with a realized outcome
  openCount: number;
  pendingCount: number; // still mid-fill -- neither a real position yet nor a finished trade
  unfillableEntryCount: number;
  unfillableExitCount: number;
  winRate: number | null; // % of closed trades with pnl_usd > 0
  totalSimulatedPnlUsd: number;
  totalSimulatedPnlPct: number | null; // sum(pnl_usd) / sum(usd_size) x 100 across closed trades -- blended return on capital actually deployed, not an average of per-trade percentages
  totalWalletExactPnlUsd: number;
  lagCostUsd: number; // totalWalletExactPnlUsd - totalSimulatedPnlUsd -- the P&L given up purely to being behind
  avgEntryDetectionLatencyMs: number | null;
  avgExitDetectionLatencyMs: number | null;
  avgEntrySlippageVsWalletPct: number | null;
  avgExitSlippageVsWalletPct: number | null;
}

function avg(values: number[]): number | null {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

/**
 * Aggregates a set of tail_trades rows into the module's headline numbers.
 * The realistic-vs-exact-fill comparison (totalSimulatedPnlUsd vs.
 * totalWalletExactPnlUsd, and their delta as lagCostUsd) is the actual
 * answer to whether copy-tailing this wallet is viable -- not the raw
 * simulated P&L number alone, since a losing simulated result could still
 * mean "the calls were good but we were too slow," and a winning one could
 * still mean "we're leaving a lot on the table vs. instant execution."
 */
export function computeTailSummary(trades: TailTradeRow[]): TailSummary {
  const closed = trades.filter((t) => t.status === "closed");
  const wins = closed.filter((t) => (t.pnl_usd ?? 0) > 0);

  return {
    tradeCount: closed.length,
    openCount: trades.filter((t) => t.status === "open").length,
    pendingCount: trades.filter((t) => t.status === "pending").length,
    unfillableEntryCount: trades.filter((t) => t.status === "unfillable_entry").length,
    unfillableExitCount: trades.filter((t) => t.status === "unfillable_exit").length,
    winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : null,
    totalSimulatedPnlUsd: closed.reduce((s, t) => s + (t.pnl_usd ?? 0), 0),
    totalSimulatedPnlPct: (() => {
      const totalDeployed = closed.reduce((s, t) => s + t.usd_size, 0);
      return totalDeployed > 0 ? (closed.reduce((s, t) => s + (t.pnl_usd ?? 0), 0) / totalDeployed) * 100 : null;
    })(),
    totalWalletExactPnlUsd: closed.reduce((s, t) => s + (t.wallet_exact_pnl_usd ?? 0), 0),
    lagCostUsd:
      closed.reduce((s, t) => s + (t.wallet_exact_pnl_usd ?? 0), 0) - closed.reduce((s, t) => s + (t.pnl_usd ?? 0), 0),
    avgEntryDetectionLatencyMs: avg(trades.map((t) => t.entry_detection_latency_ms)),
    avgExitDetectionLatencyMs: avg(closed.map((t) => t.exit_detection_latency_ms).filter((v): v is number => v != null)),
    avgEntrySlippageVsWalletPct: avg(
      trades.map((t) => t.entry_slippage_vs_wallet_pct).filter((v): v is number => v != null),
    ),
    avgExitSlippageVsWalletPct: avg(
      closed.map((t) => t.exit_slippage_vs_wallet_pct).filter((v): v is number => v != null),
    ),
  };
}
