import { test } from "node:test";
import assert from "node:assert/strict";
import { computeATR } from "./atr.js";
import type { OhlcvCandle } from "../data/types.js";

function candle(unixTime: number, o: number, h: number, l: number, c: number): OhlcvCandle {
  return { unixTime, open: o, high: h, low: l, close: c, volume: 100 };
}

test("computeATR returns undefined without enough candles for the period", () => {
  const candles = Array.from({ length: 10 }, (_, i) => candle(i, 100, 105, 95, 100));
  assert.equal(computeATR(candles, 14), undefined);
});

test("computeATR equals the constant true range when volatility is steady", () => {
  // Every candle has high-low = 10, open = close = 100 (no gaps), so true
  // range is 10 every bar -- ATR should settle exactly at 10 regardless of
  // Wilder smoothing, since there's nothing to smooth toward.
  const candles = Array.from({ length: 20 }, (_, i) => candle(i, 100, 105, 95, 100));
  assert.equal(computeATR(candles, 14), 10);
});

test("computeATR reacts to a volatility spike via Wilder smoothing, not a static average", () => {
  // First 14 candles: constant TR = 10 (seeds ATR = 10). 15th candle: a much
  // wider range bar (TR = 20). Wilder: atr = (10*13 + 20) / 14.
  const steady = Array.from({ length: 14 }, (_, i) => candle(i, 100, 105, 95, 100));
  const spike = candle(14, 100, 115, 95, 100); // high-low = 20
  const atr = computeATR([...steady, spike], 14);
  assert.equal(atr, (10 * 13 + 20) / 14);
});
