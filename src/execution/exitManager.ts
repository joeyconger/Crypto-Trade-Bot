import { getTradeSignalWallets, hasWalletSoldTokenSince, updateTradeTrailingStop, type TradeRow } from "../db/index.js";
import { findConfirmedSwing } from "../signals/fib.js";
import type { OhlcvCandle } from "../data/types.js";
import type { TokenConfig } from "../types/index.js";

/** A tracked whale (one of THIS trade's confirming entry wallets) dumping overrides everything else. */
export function checkSignalReversal(trade: TradeRow): boolean {
  const trackedWallets = getTradeSignalWallets(trade.id).map((w) => w.wallet_address);
  return hasWalletSoldTokenSince(trackedWallets, trade.token_address, trade.opened_at);
}

export type ExitAction =
  | { type: "hold" }
  | { type: "close_all"; reason: "signal_reversal" | "stop_loss" | "trailing_stop" | "time_exit"; exitPrice: number }
  | { type: "scale_1"; exitPrice: number }
  | { type: "scale_2"; exitPrice: number };

/**
 * Priority order matches the spec: signal reversal overrides everything,
 * then the stop (which IS the trailing stop once the runner is active --
 * same field, same check, just moved over time), then the scale-out
 * targets, then the unscaled-portion time exit.
 *
 * Side effect: if the runner is active and structure has advanced (a new
 * confirmed higher pivot low after a new high), this persists the trailed
 * stop via updateTradeTrailingStop before evaluating the checks below, so
 * the stop check below always sees the current stop.
 */
export function decideExitAction(
  trade: TradeRow,
  currentPrice: number,
  candles: OhlcvCandle[],
  token: TokenConfig,
  hasSignalReversal: boolean,
): ExitAction {
  let stopPrice = trade.stop_price;
  let swingHigh = trade.swing_high;

  if (trade.runner_active) {
    const swing = findConfirmedSwing(candles, token.fibPivotWindow);
    if (swing && swing.direction === "up" && swing.highPrice > swingHigh && swing.lowPrice > stopPrice) {
      updateTradeTrailingStop(trade.id, swing.lowPrice, swing.highPrice);
      stopPrice = swing.lowPrice;
      swingHigh = swing.highPrice;
    }
  }

  if (hasSignalReversal) {
    return { type: "close_all", reason: "signal_reversal", exitPrice: currentPrice };
  }

  if (currentPrice <= stopPrice) {
    return { type: "close_all", reason: trade.runner_active ? "trailing_stop" : "stop_loss", exitPrice: currentPrice };
  }

  if (!trade.scale_out_1_done && currentPrice >= trade.extension_1272_price) {
    return { type: "scale_1", exitPrice: currentPrice };
  }

  if (trade.scale_out_1_done && !trade.scale_out_2_done && currentPrice >= trade.extension_1618_price) {
    return { type: "scale_2", exitPrice: currentPrice };
  }

  // Time exit applies only before the position has proven itself with the
  // first scale-out -- once scale_out_1 has fired, the clock no longer matters.
  if (!trade.scale_out_1_done && Date.now() > new Date(trade.time_exit_deadline).getTime()) {
    return { type: "close_all", reason: "time_exit", exitPrice: currentPrice };
  }

  return { type: "hold" };
}
