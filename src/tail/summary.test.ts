import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTailSummary } from "./summary.js";
import type { TailTradeRow } from "./db.js";

function trade(overrides: Partial<TailTradeRow>): TailTradeRow {
  return {
    id: 1,
    wallet_address: "W",
    token_address: "T",
    token_symbol: "TKN",
    status: "closed",
    usd_size: 100,
    quantity: 10,
    wallet_entry_price_usd: 1,
    wallet_entry_tx_signature: "sig-entry",
    wallet_entry_onchain_at: "2026-01-01T00:00:00.000Z",
    entry_detected_at: "2026-01-01T00:00:01.000Z",
    entry_detection_latency_ms: 1000,
    sim_entry_fill_at: "2026-01-01T00:00:06.000Z",
    sim_entry_fill_price_usd: 1.05,
    entry_liquidity_usd: 50000,
    entry_market_cap_usd: 250000,
    entry_slippage_vs_wallet_pct: 5,
    wallet_exit_price_usd: 1.2,
    wallet_exit_tx_signature: "sig-exit",
    wallet_exit_onchain_at: "2026-01-01T01:00:00.000Z",
    exit_detected_at: "2026-01-01T01:00:01.000Z",
    exit_detection_latency_ms: 1000,
    sim_exit_fill_at: "2026-01-01T01:00:06.000Z",
    sim_exit_fill_price_usd: 1.15,
    exit_liquidity_usd: 50000,
    exit_market_cap_usd: 275000,
    exit_slippage_vs_wallet_pct: -4.1666,
    pnl_usd: 10, // (1.15 - 1.05) * 10
    pnl_pct: 10,
    wallet_exact_pnl_usd: 20, // (1.2 - 1.0) * 10
    wallet_exact_pnl_pct: 20,
    closed_manually: 0,
    created_at: "2026-01-01T00:00:01.000Z",
    updated_at: "2026-01-01T01:00:06.000Z",
    ...overrides,
  };
}

test("computeTailSummary: aggregates closed trades and computes lag cost", () => {
  const trades = [
    trade({ id: 1, pnl_usd: 10, wallet_exact_pnl_usd: 20 }),
    trade({ id: 2, pnl_usd: -5, wallet_exact_pnl_usd: -2, entry_detection_latency_ms: 3000 }),
  ];

  const summary = computeTailSummary(trades);

  assert.equal(summary.tradeCount, 2);
  assert.equal(summary.winRate, 50);
  assert.equal(summary.totalSimulatedPnlUsd, 5);
  assert.equal(summary.totalWalletExactPnlUsd, 18);
  assert.equal(summary.lagCostUsd, 13); // 18 - 5
  assert.equal(summary.avgEntryDetectionLatencyMs, 2000);
});

test("computeTailSummary: open and unfillable trades are counted but excluded from win rate/P&L", () => {
  const trades = [
    trade({ id: 1, status: "closed", pnl_usd: 10, wallet_exact_pnl_usd: 15 }),
    trade({ id: 2, status: "open", pnl_usd: null, wallet_exact_pnl_usd: null, sim_exit_fill_price_usd: null, exit_detection_latency_ms: null }),
    trade({ id: 3, status: "unfillable_entry", quantity: null, pnl_usd: null, wallet_exact_pnl_usd: null }),
    trade({ id: 4, status: "unfillable_exit", pnl_usd: null, wallet_exact_pnl_usd: null }),
  ];

  const summary = computeTailSummary(trades);

  assert.equal(summary.tradeCount, 1);
  assert.equal(summary.openCount, 1);
  assert.equal(summary.unfillableEntryCount, 1);
  assert.equal(summary.unfillableExitCount, 1);
  assert.equal(summary.winRate, 100);
  assert.equal(summary.totalSimulatedPnlUsd, 10);
  assert.equal(summary.totalWalletExactPnlUsd, 15);
});

test("computeTailSummary: no closed trades yields null win rate, zero totals", () => {
  const summary = computeTailSummary([trade({ id: 1, status: "open", pnl_usd: null, wallet_exact_pnl_usd: null })]);

  assert.equal(summary.tradeCount, 0);
  assert.equal(summary.winRate, null);
  assert.equal(summary.totalSimulatedPnlUsd, 0);
  assert.equal(summary.totalWalletExactPnlUsd, 0);
  assert.equal(summary.lagCostUsd, 0);
});
