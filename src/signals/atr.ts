import type { OhlcvCandle } from "../data/types.js";

/**
 * Average True Range via Wilder's smoothing (the standard ATR, not a plain
 * SMA of true range) -- reacts to the current volatility regime rather than
 * lagging a fixed static window, per "recalculated on a rolling basis."
 * Returns undefined if there isn't enough candle history for the period.
 */
export function computeATR(candles: OhlcvCandle[], period = 14): number | undefined {
  if (candles.length < period + 1) return undefined;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    trueRanges.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)));
  }

  if (trueRanges.length < period) return undefined;

  let atr = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return atr;
}
