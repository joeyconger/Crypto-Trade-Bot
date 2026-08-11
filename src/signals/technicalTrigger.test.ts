import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateTechnicalTrigger } from "./technicalTrigger.js";
import type { OhlcvCandle } from "../data/types.js";
import type { TokenConfig } from "../types/index.js";

function candle(unixTime: number, o: number, h: number, l: number, c: number, v = 100): OhlcvCandle {
  return { unixTime, open: o, high: h, low: l, close: c, volume: v };
}

const token = {
  fibPivotWindow: 2,
  goldenPocketZonePct: 2,
  trendSmaPeriod: 30,
  chopLookbackPeriods: 8,
  chopMaxCrossings: 5,
  rsiPeriod: 5,
  rsiMidline: 55,
  rsiOverboughtCeiling: 75,
  volumeAvgPeriod: 5,
  volumeConfirmationMultiplier: 1.5,
} as TokenConfig;

/**
 * A hand-tuned "everything lines up" series: a flat low anchor (keeps the
 * trend SMA well below the pullback zone regardless of the swing specifics),
 * an early waypoint pivot at ~13.65 that predates the swing low (so it can
 * never override the swing itself, but still gives structural confluence),
 * a swing from 9.6 -> 20.2, and a pullback into the 0.618 zone where the
 * reaction candle wicks in, closes back above the zone AND above the prior
 * close (RSI turns up), with a volume spike.
 */
function baseCandles(): OhlcvCandle[] {
  const c: OhlcvCandle[] = [];
  let t = 0;
  const base = [8.5, 8.6, 8.4, 8.55, 8.45, 8.5, 8.6, 8.4, 8.5, 8.55, 8.5, 8.45];
  for (const p of base) c.push(candle(t++, p, p + 0.1, p - 0.1, p));

  c.push(candle(t++, 10, 10.5, 9.9, 10.4));
  c.push(candle(t++, 10.4, 11.5, 10.3, 11.4));
  c.push(candle(t++, 11.4, 13.65, 11.3, 13.5)); // waypoint pivot high ~13.65
  c.push(candle(t++, 13.5, 13.5, 12, 12.1));
  c.push(candle(t++, 12.1, 12.2, 11, 11.1));

  c.push(candle(t++, 11.1, 11.2, 10.2, 10.3));
  c.push(candle(t++, 10.3, 10.4, 9.6, 9.7)); // pivot low ~9.6
  c.push(candle(t++, 9.7, 10.5, 9.7, 10.4));
  c.push(candle(t++, 10.4, 11, 10.3, 10.9));

  c.push(candle(t++, 10.9, 13, 10.8, 12.9));
  c.push(candle(t++, 12.9, 15.5, 12.8, 15.4));
  c.push(candle(t++, 15.4, 18, 15.3, 17.9));
  c.push(candle(t++, 17.9, 20.2, 17.8, 20)); // pivot high ~20.2
  c.push(candle(t++, 20, 20.1, 18.5, 18.7));
  c.push(candle(t++, 18.7, 18.8, 17, 17.2));

  c.push(candle(t++, 17.2, 17.3, 16, 16.1));
  c.push(candle(t++, 16.1, 16.2, 15, 15.1));
  c.push(candle(t++, 15.1, 15.2, 14.2, 14.3));
  c.push(candle(t++, 14.3, 14.4, 13.3, 13.4));
  c.push(candle(t++, 13.4, 13.9, 13.35, 13.85, 500)); // reaction candle

  return c;
}

test("evaluateTechnicalTrigger passes when every condition lines up", () => {
  const candles = baseCandles();
  const result = evaluateTechnicalTrigger(candles, candles.at(-1)!.close, token);
  assert.equal(result.passed, true);
  assert.equal(result.matchedLevel?.level, 0.618);
});

test("evaluateTechnicalTrigger fails when price is below the trend SMA", () => {
  const candles = baseCandles();
  candles[candles.length - 1] = { ...candles.at(-1)!, close: 5 };
  const result = evaluateTechnicalTrigger(candles, 5, token);
  assert.equal(result.passed, false);
  assert.match(result.reason, /not fighting the trend/);
});

test("evaluateTechnicalTrigger fails without a volume spike on the reaction candle", () => {
  const candles = baseCandles();
  candles[candles.length - 1] = { ...candles.at(-1)!, volume: 100 };
  const result = evaluateTechnicalTrigger(candles, candles.at(-1)!.close, token);
  assert.equal(result.passed, false);
  assert.match(result.reason, /volume/);
});

test("evaluateTechnicalTrigger fails on a wick-only touch (no confirmed close back above the zone)", () => {
  const candles = baseCandles();
  // still comfortably above the trend SMA (~12), but doesn't close back above the 13.65 zone
  candles[candles.length - 1] = { ...candles.at(-1)!, close: 13.5 };
  const result = evaluateTechnicalTrigger(candles, 13.5, token);
  assert.equal(result.passed, false);
  assert.match(result.reason, /wick only/);
});

test("evaluateTechnicalTrigger fails when RSI isn't turning up", () => {
  const candles = baseCandles();
  // still within the golden pocket zone, but lower than the prior candle
  // (13.4) -- RSI keeps falling, not turning
  candles[candles.length - 1] = { ...candles.at(-1)!, close: 13.38, open: 13.4 };
  const result = evaluateTechnicalTrigger(candles, 13.38, token);
  assert.equal(result.passed, false);
  assert.match(result.reason, /RSI/);
});

test("evaluateTechnicalTrigger fails when the market is too choppy", () => {
  const candles = baseCandles();
  const start = candles.length - 8;
  for (let i = start; i < candles.length - 1; i++) {
    candles[i] = { ...candles[i], close: i % 2 === 0 ? 20 : 8, high: 20.5, low: 7.5 };
  }
  const result = evaluateTechnicalTrigger(candles, candles.at(-1)!.close, token);
  assert.equal(result.passed, false);
});
