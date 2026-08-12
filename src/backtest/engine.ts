import { evaluateTechnicalTrigger } from "../signals/technicalTrigger.js";
import { computeATR } from "../signals/atr.js";
import { computeFibExtensions, findConfirmedSwing } from "../signals/fib.js";
import { computeInitialStop, computePositionSize } from "../execution/positionSizing.js";
import { decideExitAction, type ExitAction } from "../execution/exitManager.js";
import type { OhlcvCandle } from "../data/types.js";
import type { TokenConfig } from "../types/index.js";

/**
 * Walk-forward backtest of Conditions 1-6 (the technical trigger) ONLY.
 *
 * IMPORTANT: Condition 7 (on-chain confluence) is NOT simulated here, and
 * that is not a minor caveat -- in the live/paper bot, Condition 7 is a
 * REQUIRED gate (src/onchain/entryTrigger.ts). A technical setup with no
 * qualifying wallet confirmation never opens a position. This backtest
 * cannot reproduce that: it would need historical, wallet-level buy/sell
 * data for every candidate wallet on every token, at the specific moments
 * being backtested, plus that wallet's reputation AS OF that historical
 * moment (not its current reputation, which would be look-ahead bias) --
 * data this sandbox has no way to fetch (no live network access) and that
 * would be expensive to gather even with it (Helius per-wallet history
 * lookups, at volume, for months of data across many tokens).
 *
 * What this DOES tell you: whether Conditions 1-6 alone identify favorable
 * entry TIMING -- i.e. whether the technical filter has any signal at all.
 * What it does NOT tell you: what the deployed bot's actual trade set,
 * frequency, or P&L would have been, since every one of the trades below
 * would additionally have needed a Tier A or Tier B on-chain confirmation
 * to actually fire live. Treat this as a diagnostic on the technical filter,
 * not a substitute for validating the full strategy. See README's
 * "Backtesting before live capital" section for how to close that gap
 * (forward paper-trading validation).
 */

export interface BacktestConfig {
  startingBankrollUsd: number;
  feeBps: number; // round-trip-per-fill swap fee assumption
  slippageBps: number; // round-trip-per-fill slippage assumption
}

export interface BacktestFill {
  tranche: "scale_1" | "scale_2" | "runner" | "time_exit" | "stop_loss";
  price: number; // AFTER fee/slippage haircut
  quantity: number;
  time: number;
  reason: string;
}

export interface BacktestTrade {
  entryTime: number;
  entryPrice: number; // AFTER fee/slippage haircut
  quantity: number;
  stopPrice: number;
  fills: BacktestFill[];
  closedAt: number;
  exitPriceWeighted: number;
  pnlUsd: number;
  pnlPct: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  finalBankrollUsd: number;
  maxDrawdownPct: number;
  buyAndHoldReturnPct: number;
}

function applyHaircut(price: number, side: "buy" | "sell", cfg: BacktestConfig): number {
  const totalBps = cfg.feeBps + cfg.slippageBps;
  // Buys fill worse (higher) than quoted; sells fill worse (lower).
  return side === "buy" ? price * (1 + totalBps / 10000) : price * (1 - totalBps / 10000);
}

interface OpenPosition {
  entryTime: number;
  entryPrice: number;
  quantity: number;
  quantityRemaining: number;
  swingHigh: number;
  swingLow: number;
  atrAtEntry: number;
  extension1272Price: number;
  extension1618Price: number;
  stopPrice: number;
  scaleOut1Done: boolean;
  scaleOut2Done: boolean;
  runnerActive: boolean;
  timeExitDeadline: number;
  fills: BacktestFill[];
  usdSize: number;
}

/** Adapts our lightweight OpenPosition into the shape decideExitAction expects, without a real DB row. */
function toTradeRowLike(pos: OpenPosition) {
  return {
    id: 0,
    entry_price: pos.entryPrice,
    quantity: pos.quantity,
    quantity_remaining: pos.quantityRemaining,
    usd_size: pos.usdSize,
    swing_high: pos.swingHigh,
    swing_low: pos.swingLow,
    atr_at_entry: pos.atrAtEntry,
    extension_1272_price: pos.extension1272Price,
    extension_1618_price: pos.extension1618Price,
    stop_price: pos.stopPrice,
    scale_out_1_done: pos.scaleOut1Done ? 1 : 0,
    scale_out_2_done: pos.scaleOut2Done ? 1 : 0,
    runner_active: pos.runnerActive ? 1 : 0,
    time_exit_deadline: new Date(pos.timeExitDeadline).toISOString(),
  } as unknown as Parameters<typeof decideExitAction>[0];
}

export function runBacktest(token: TokenConfig, candles: OhlcvCandle[], cfg: BacktestConfig): BacktestResult {
  const sorted = [...candles].sort((a, b) => a.unixTime - b.unixTime);
  const trades: BacktestTrade[] = [];
  let bankrollUsd = cfg.startingBankrollUsd;
  let peakBankrollUsd = cfg.startingBankrollUsd;
  let maxDrawdownPct = 0;
  let open: OpenPosition | undefined;

  const minWarmup = Math.max(
    token.trendSmaPeriod,
    token.rsiPeriod + 1,
    token.volumeAvgPeriod + 1,
    token.atrPeriod + 1,
    token.fibPivotWindow * 2 + 5,
  );

  const trackDrawdown = () => {
    peakBankrollUsd = Math.max(peakBankrollUsd, bankrollUsd);
    const drawdownPct = ((peakBankrollUsd - bankrollUsd) / peakBankrollUsd) * 100;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
  };

  for (let i = minWarmup; i < sorted.length; i++) {
    // Walk-forward: only candles up to and including bar i are visible --
    // no lookahead into future price action.
    const windowCandles = sorted.slice(0, i + 1);
    const bar = sorted[i];
    const currentPrice = bar.close;

    if (open) {
      // Replicates decideExitAction's runner-trailing-stop advance ourselves
      // (rather than relying on decideExitAction to do it) because that
      // function's side effect is a real DB write (updateTradeTrailingStop)
      // keyed off a real trade id -- meaningless/unsafe outside the live DB.
      // Advancing open.stopPrice here BEFORE calling decideExitAction means
      // its own internal copy of the same check is always a no-op (the
      // condition it's testing is already satisfied), so it never attempts
      // that write, and the stop/price comparison below correctly sees the
      // already-advanced stop either way.
      if (open.runnerActive) {
        const swing = findConfirmedSwing(windowCandles, token.fibPivotWindow);
        if (swing && swing.direction === "up" && swing.highPrice > open.swingHigh && swing.lowPrice > open.stopPrice) {
          open.stopPrice = swing.lowPrice;
          open.swingHigh = swing.highPrice;
        }
      }

      const candlesForExit = open.runnerActive ? windowCandles : [];
      let action: ExitAction = decideExitAction(toTradeRowLike(open), currentPrice, candlesForExit, token, false);

      // decideExitAction's time-exit branch compares real Date.now() against
      // time_exit_deadline -- correct for the live bot, meaningless for a
      // backtest walking historical (necessarily past) timestamps, since
      // real "now" is always later than any historical deadline. That makes
      // it fire on literally the first bar after every entry. Recompute
      // that one branch using the SIMULATED bar time instead; every other
      // branch (reversal/stop/scale-outs, all checked with higher priority
      // inside decideExitAction already) is unaffected and still authoritative.
      if (action.type === "close_all" && action.reason === "time_exit") {
        const simulatedTimeExitDue = !open.scaleOut1Done && bar.unixTime * 1000 > open.timeExitDeadline;
        if (!simulatedTimeExitDue) action = { type: "hold" };
      }

      if (action.type === "scale_1" || action.type === "scale_2") {
        const pct = action.type === "scale_1" ? token.scaleOutPct1 : token.scaleOutPct2;
        const qty = open.quantity * (pct / 100);
        const fillPrice = applyHaircut(action.exitPrice, "sell", cfg);
        open.fills.push({ tranche: action.type, price: fillPrice, quantity: qty, time: bar.unixTime, reason: action.type });
        open.quantityRemaining -= qty;
        if (action.type === "scale_1") open.scaleOut1Done = true;
        else {
          open.scaleOut2Done = true;
          open.runnerActive = true;
          // Structure stop moves to breakeven the moment the runner activates.
          open.stopPrice = Math.max(open.stopPrice, open.entryPrice);
        }
      } else if (action.type === "close_all") {
        const fillPrice = applyHaircut(action.exitPrice, "sell", cfg);
        // tranche = WHICH portion is closing (runner if scale_2 already
        // fired, else the whole pre-scale-out position); reason = WHY,
        // taken directly from decideExitAction's own reason -- mirrors the
        // tranche/exit_reason split in db/schema.sql's position_exits table.
        const trancheLabel = open.scaleOut2Done ? "runner" : action.reason === "time_exit" ? "time_exit" : "stop_loss";
        open.fills.push({
          tranche: trancheLabel,
          price: fillPrice,
          quantity: open.quantityRemaining,
          time: bar.unixTime,
          reason: action.reason,
        });
        open.quantityRemaining = 0;

        const totalQty = open.fills.reduce((s, f) => s + f.quantity, 0);
        const exitPriceWeighted = open.fills.reduce((s, f) => s + f.price * f.quantity, 0) / totalQty;
        const pnlUsd = open.fills.reduce((s, f) => s + (f.price - open!.entryPrice) * f.quantity, 0);
        const pnlPct = (pnlUsd / open.usdSize) * 100;

        bankrollUsd += pnlUsd;
        trackDrawdown();

        trades.push({
          entryTime: open.entryTime,
          entryPrice: open.entryPrice,
          quantity: open.quantity,
          stopPrice: open.stopPrice,
          fills: open.fills,
          closedAt: bar.unixTime,
          exitPriceWeighted,
          pnlUsd,
          pnlPct,
        });
        open = undefined;
      }
      // "hold" -- nothing else to do; the trailing-stop advance (if any)
      // already happened above, before decideExitAction was even called.
      continue;
    }

    // No open position -- evaluate Conditions 1-6.
    const technical = evaluateTechnicalTrigger(windowCandles, currentPrice, token);
    if (!technical.passed) continue;

    const atr = computeATR(windowCandles, token.atrPeriod);
    const swing = technical.swing!;
    const stopPrice = atr !== undefined ? computeInitialStop(swing.lowPrice, atr, token.stopAtrMultiplier) : undefined;
    if (atr === undefined || stopPrice === undefined || stopPrice >= currentPrice) continue;

    // No Condition 7 in this backtest (see module doc comment) -- sized at
    // the base riskPctPerTrade since there's no tier to size by without a
    // simulated on-chain confirmation. Real deployed trades would be Tier A
    // or Tier B, sized accordingly.
    const sizing = computePositionSize(bankrollUsd, currentPrice, stopPrice, 1, 100);
    const entryPrice = applyHaircut(currentPrice, "buy", cfg);
    const extensions = computeFibExtensions(swing, [token.extensionRatio1, token.extensionRatio2]);

    open = {
      entryTime: bar.unixTime,
      entryPrice,
      quantity: sizing.quantity,
      quantityRemaining: sizing.quantity,
      swingHigh: swing.highPrice,
      swingLow: swing.lowPrice,
      atrAtEntry: atr,
      extension1272Price: extensions.find((e) => e.level === token.extensionRatio1)!.price,
      extension1618Price: extensions.find((e) => e.level === token.extensionRatio2)!.price,
      stopPrice,
      scaleOut1Done: false,
      scaleOut2Done: false,
      runnerActive: false,
      timeExitDeadline: bar.unixTime * 1000 + token.timeExitHours * 60 * 60 * 1000,
      fills: [],
      usdSize: sizing.usdSize,
    };
  }

  const firstClose = sorted[minWarmup]?.close ?? sorted[0]?.close ?? 0;
  const lastClose = sorted[sorted.length - 1]?.close ?? firstClose;
  const buyAndHoldReturnPct = firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0;

  return { trades, finalBankrollUsd: bankrollUsd, maxDrawdownPct, buyAndHoldReturnPct };
}
