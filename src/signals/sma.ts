import type { OhlcvCandle } from "../data/types.js";

export function computeSMA(candles: OhlcvCandle[], period: number): number | undefined {
  if (candles.length < period) return undefined;
  const window = candles.slice(-period);
  return window.reduce((sum, c) => sum + c.close, 0) / period;
}

/**
 * Counts how many times price crossed its own SMA over the last
 * `lookbackPeriods` candles -- a simple chop detector. A trending market
 * stays on one side of its MA; a ranging one whips back and forth across it.
 */
export function countMaCrossings(candles: OhlcvCandle[], smaPeriod: number, lookbackPeriods: number): number {
  if (candles.length < smaPeriod + lookbackPeriods) return 0;

  let crossings = 0;
  let prevAbove: boolean | undefined;
  const startIdx = candles.length - lookbackPeriods;

  for (let i = startIdx; i < candles.length; i++) {
    const window = candles.slice(i - smaPeriod + 1, i + 1);
    if (window.length < smaPeriod) continue;

    const sma = window.reduce((sum, c) => sum + c.close, 0) / smaPeriod;
    const above = candles[i].close > sma;
    if (prevAbove !== undefined && above !== prevAbove) crossings++;
    prevAbove = above;
  }

  return crossings;
}
