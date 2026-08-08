import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSMA, countMaCrossings } from "./sma.js";
import type { OhlcvCandle } from "../data/birdeye.js";

function candle(unixTime: number, close: number): OhlcvCandle {
  return { unixTime, open: close, high: close, low: close, close, volume: 100 };
}

test("computeSMA averages the last N closes", () => {
  const candles = [10, 20, 30, 40, 50].map((c, i) => candle(i, c));
  assert.equal(computeSMA(candles, 5), 30);
  assert.equal(computeSMA(candles, 3), 40); // avg of 30, 40, 50
});

test("computeSMA returns undefined without enough candles", () => {
  const candles = [candle(0, 10), candle(1, 20)];
  assert.equal(computeSMA(candles, 5), undefined);
});

test("countMaCrossings is low for a steadily trending series", () => {
  const candles = Array.from({ length: 40 }, (_, i) => candle(i, 100 + i * 2)); // strictly increasing
  const crossings = countMaCrossings(candles, 10, 20);
  assert.ok(crossings <= 1, `expected a trending series to cross its MA rarely, got ${crossings}`);
});

test("countMaCrossings is high for a whipsawing series", () => {
  const candles = Array.from({ length: 40 }, (_, i) => candle(i, 100 + (i % 2 === 0 ? 20 : -20)));
  const crossings = countMaCrossings(candles, 10, 20);
  assert.ok(crossings >= 3, `expected a choppy series to cross its MA often, got ${crossings}`);
});
