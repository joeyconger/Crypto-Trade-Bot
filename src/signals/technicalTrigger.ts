import type { OhlcvCandle } from "../data/types.js";
import type { TokenConfig } from "../types/index.js";
import { checkGoldenPocket, findPivots, isWithinZone, type Swing, type FibLevel } from "./fib.js";
import { computeSMA, countMaCrossings } from "./sma.js";
import { computeRSISeries } from "./rsi.js";

export interface TechnicalTriggerResult {
  passed: boolean;
  reason: string;
  swing?: Swing;
  matchedLevel?: FibLevel;
}

/**
 * The entry gate: all five conditions required, no on-chain confirmation
 * needed. Checked cheapest/most-likely-to-fail-first so a token that's
 * obviously not set up (wrong side of its trend, choppy) doesn't pay for the
 * more expensive downstream checks.
 *
 * 1. Trend filter: price above trendSmaPeriod SMA, and not choppy (fewer
 *    than chopMaxCrossings MA crossings in the recent window).
 * 2. Fib zone + structural confluence: price at the confirmed swing's
 *    0.5/0.618 retracement, AND that level sits near a prior pivot
 *    (real prior support/resistance, not just an arbitrary ratio).
 * 3. RSI momentum: turning up from below rsiMidline, not already past
 *    rsiOverboughtCeiling (catching a pullback, not chasing).
 * 4. Volume confirmation: the reaction candle clears volumeConfirmationMultiplier
 *    x the volumeAvgPeriod average.
 * 5. Candle close confirmation: a full close back above the zone, with the
 *    zone actually having been traded into first -- not just a wick touch.
 */
export function evaluateTechnicalTrigger(
  candles: OhlcvCandle[],
  currentPrice: number,
  token: TokenConfig,
): TechnicalTriggerResult {
  const sma = computeSMA(candles, token.trendSmaPeriod);
  if (sma === undefined) {
    return { passed: false, reason: `not enough candle history for the SMA(${token.trendSmaPeriod}) trend filter` };
  }
  if (currentPrice <= sma) {
    return { passed: false, reason: `price ${currentPrice} at/below SMA(${token.trendSmaPeriod}) ${sma.toFixed(6)} -- not fighting the trend` };
  }

  const crossings = countMaCrossings(candles, token.trendSmaPeriod, token.chopLookbackPeriods);
  if (crossings >= token.chopMaxCrossings) {
    return { passed: false, reason: `market looks choppy (${crossings} MA crossings in the last ${token.chopLookbackPeriods} candles)` };
  }

  const goldenPocket = checkGoldenPocket(candles, currentPrice, token.fibPivotWindow, token.goldenPocketZonePct);
  if (!goldenPocket.passed) {
    return { passed: false, reason: goldenPocket.reason };
  }

  const pivots = findPivots(candles, token.fibPivotWindow);
  const hasStructuralConfluence = pivots.some((p) => isWithinZone(goldenPocket.matchedLevel!.price, p.price, token.goldenPocketZonePct));
  if (!hasStructuralConfluence) {
    return { passed: false, reason: "fib zone has no structural confluence -- no prior support/resistance level nearby", swing: goldenPocket.swing };
  }

  const rsiSeries = computeRSISeries(candles, token.rsiPeriod);
  if (rsiSeries.length < 2) {
    return { passed: false, reason: `not enough candle history for RSI(${token.rsiPeriod})` };
  }
  const [prevRsi, currRsi] = rsiSeries.slice(-2);
  if (!(currRsi < token.rsiMidline && currRsi > prevRsi)) {
    return {
      passed: false,
      reason: `RSI(${token.rsiPeriod}) ${currRsi.toFixed(1)} isn't turning up from below ${token.rsiMidline} (prev ${prevRsi.toFixed(1)})`,
    };
  }
  if (currRsi > token.rsiOverboughtCeiling) {
    return { passed: false, reason: `RSI(${token.rsiPeriod}) ${currRsi.toFixed(1)} already above ${token.rsiOverboughtCeiling} -- chasing, not catching a pullback` };
  }

  const last = candles.at(-1)!;
  const priorWindow = candles.slice(0, -1).slice(-token.volumeAvgPeriod);
  if (priorWindow.length < token.volumeAvgPeriod) {
    return { passed: false, reason: `not enough candle history for the ${token.volumeAvgPeriod}-period volume average` };
  }
  const avgVolume = priorWindow.reduce((sum, c) => sum + c.volume, 0) / token.volumeAvgPeriod;
  if (last.volume < avgVolume * token.volumeConfirmationMultiplier) {
    return {
      passed: false,
      reason: `reaction candle volume ${last.volume.toFixed(0)} below ${token.volumeConfirmationMultiplier}x the ${token.volumeAvgPeriod}-period average (${avgVolume.toFixed(0)})`,
    };
  }

  const zonePrice = goldenPocket.matchedLevel!.price;
  const zoneEdge = zonePrice * (1 + token.goldenPocketZonePct / 100);
  const prev = candles.at(-2)!;
  const tradedIntoZone = prev.low <= zoneEdge || last.low <= zoneEdge;
  const closedBackAbove = last.close > zonePrice;
  if (!tradedIntoZone || !closedBackAbove) {
    return { passed: false, reason: "no confirmed close back above the fib zone yet -- wick only, not a close" };
  }

  return {
    passed: true,
    reason: `trend up (SMA${token.trendSmaPeriod}), fib ${goldenPocket.matchedLevel!.level} w/ structural confluence, RSI ${currRsi.toFixed(1)} turning up, volume ${(last.volume / avgVolume).toFixed(1)}x avg, close confirmed`,
    swing: goldenPocket.swing,
    matchedLevel: goldenPocket.matchedLevel,
  };
}
