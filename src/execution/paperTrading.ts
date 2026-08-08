import {
  insertTrade,
  insertPositionExit,
  markScaleOut1Done,
  markScaleOut2Done,
  closeTradeFully,
  type TradeRow,
  type PlannedTradeInput,
} from "../db/index.js";
import { computeTrancheQuantities } from "./positionSizing.js";

function pnlFor(quantity: number, entryPrice: number, exitPrice: number): number {
  return (exitPrice - entryPrice) * quantity;
}

/** Simulates a fill at the current price -- no real transaction, paper mode only. */
export function openPaperPosition(plan: PlannedTradeInput, currentPrice: number): number {
  const quantity = plan.usdSize / currentPrice;
  return insertTrade({ ...plan, mode: "paper", entryPrice: currentPrice, quantity });
}

/** The 33% (configurable) partial exit at an extension target. Trade stays open -- quantity_remaining just drops. */
export function executePaperScaleOut(
  trade: TradeRow,
  tranche: "scale_1" | "scale_2",
  exitPrice: number,
  exitReason: string,
  scaleOutPct1: number,
  scaleOutPct2: number,
): void {
  const { scale1Qty, scale2Qty } = computeTrancheQuantities(trade.quantity, scaleOutPct1, scaleOutPct2);
  const qty = tranche === "scale_1" ? scale1Qty : scale2Qty;

  insertPositionExit({
    tradeId: trade.id,
    tranche,
    quantity: qty,
    exitPrice,
    exitReason,
    pnlUsd: pnlFor(qty, trade.entry_price, exitPrice),
  });

  if (tranche === "scale_1") {
    markScaleOut1Done(trade.id, trade.quantity_remaining - qty);
  } else {
    markScaleOut2Done(trade.id, trade.quantity_remaining - qty, trade.entry_price); // moves stop to breakeven, activates the runner
  }
}

/**
 * Closes whatever quantity is still open, for any reason other than hitting
 * an extension target (stop loss, trailing stop, time exit, signal reversal)
 * -- logged as the 'runner' tranche whether it's actually the trailing
 * runner or the full original position closing before any scale-out ever fired.
 */
export function closePaperPositionRemainder(trade: TradeRow, exitPrice: number, exitReason: string): void {
  const qty = trade.quantity_remaining;
  insertPositionExit({
    tradeId: trade.id,
    tranche: "runner",
    quantity: qty,
    exitPrice,
    exitReason,
    pnlUsd: pnlFor(qty, trade.entry_price, exitPrice),
  });
  closeTradeFully(trade.id);
}
