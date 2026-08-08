import type { OhlcvCandle } from "../data/birdeye.js";

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * RSI via Wilder's smoothing, returned as a series (one value per candle
 * after the initial `period` seed) so callers can compare the latest value
 * against the previous one to detect a turn, not just a level.
 */
export function computeRSISeries(candles: OhlcvCandle[], period: number): number[] {
  if (candles.length < period + 1) return [];

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    gains.push(Math.max(change, 0));
    losses.push(Math.max(-change, 0));
  }

  let avgGain = gains.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((sum, v) => sum + v, 0) / period;

  const series = [rsiFromAverages(avgGain, avgLoss)];
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    series.push(rsiFromAverages(avgGain, avgLoss));
  }

  return series;
}
