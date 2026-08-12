import { test } from "node:test";
import assert from "node:assert/strict";
import { decideExitAction } from "./exitManager.js";
import type { TradeRow } from "../db/index.js";
import type { TokenConfig } from "../types/index.js";

function baseTrade(overrides: Partial<TradeRow> = {}): TradeRow {
  return {
    id: 1,
    token_address: "TOKEN",
    token_symbol: "TKN",
    mode: "paper",
    side: "buy",
    status: "open",
    entry_price: 100,
    quantity: 10,
    quantity_remaining: 10,
    usd_size: 1000,
    swing_high: 120,
    swing_low: 80,
    fib_zone_level: 0.618,
    atr_at_entry: 5,
    extension_1272_price: 130,
    extension_1618_price: 145,
    stop_price: 90,
    scale_out_1_done: 0,
    scale_out_2_done: 0,
    runner_active: 0,
    time_exit_deadline: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    confluence_tier: "A",
    reason: "test",
    tx_signature: null,
    exit_price: null,
    pnl_usd: null,
    pnl_pct: null,
    opened_at: new Date().toISOString(),
    closed_at: null,
    ...overrides,
  };
}

const token = { fibPivotWindow: 5 } as TokenConfig;

test("decideExitAction holds when nothing has triggered", () => {
  const action = decideExitAction(baseTrade(), 100, [], token, false);
  assert.equal(action.type, "hold");
});

test("decideExitAction closes on signal reversal even when a target was also hit", () => {
  const action = decideExitAction(baseTrade(), 130, [], token, true);
  assert.equal(action.type, "close_all");
  if (action.type === "close_all") assert.equal(action.reason, "signal_reversal");
});

test("decideExitAction closes on stop loss when price drops to the stop", () => {
  const action = decideExitAction(baseTrade({ stop_price: 90 }), 89, [], token, false);
  assert.equal(action.type, "close_all");
  if (action.type === "close_all") assert.equal(action.reason, "stop_loss");
});

test("decideExitAction reports trailing_stop (not stop_loss) once the runner is active", () => {
  const action = decideExitAction(baseTrade({ runner_active: 1, stop_price: 140 }), 139, [], token, false);
  assert.equal(action.type, "close_all");
  if (action.type === "close_all") assert.equal(action.reason, "trailing_stop");
});

test("decideExitAction fires scale_1 at the 1.272 extension", () => {
  const action = decideExitAction(baseTrade(), 130, [], token, false);
  assert.equal(action.type, "scale_1");
});

test("decideExitAction does not fire scale_2 before scale_1 has happened", () => {
  const action = decideExitAction(baseTrade({ scale_out_1_done: 0 }), 145, [], token, false);
  // price also clears extension_1272 (130), so scale_1 should fire first, not scale_2
  assert.equal(action.type, "scale_1");
});

test("decideExitAction fires scale_2 at the 1.618 extension once scale_1 is done", () => {
  const action = decideExitAction(baseTrade({ scale_out_1_done: 1 }), 145, [], token, false);
  assert.equal(action.type, "scale_2");
});

test("decideExitAction time-exits the unscaled portion after the deadline", () => {
  const trade = baseTrade({ time_exit_deadline: new Date(Date.now() - 1000).toISOString() });
  const action = decideExitAction(trade, 100, [], token, false);
  assert.equal(action.type, "close_all");
  if (action.type === "close_all") assert.equal(action.reason, "time_exit");
});

test("decideExitAction never time-exits once scale_out_1 has already fired", () => {
  const trade = baseTrade({
    scale_out_1_done: 1,
    time_exit_deadline: new Date(Date.now() - 1000).toISOString(),
  });
  const action = decideExitAction(trade, 100, [], token, false);
  assert.equal(action.type, "hold");
});
