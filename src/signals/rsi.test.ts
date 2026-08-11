import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRSISeries } from "./rsi.js";
import type { OhlcvCandle } from "../data/types.js";

function candle(unixTime: number, close: number): OhlcvCandle {
  return { unixTime, open: close, high: close, low: close, close, volume: 100 };
}

test("computeRSISeries returns empty without enough candles", () => {
  const candles = [candle(0, 10), candle(1, 11)];
  assert.deepEqual(computeRSISeries(candles, 14), []);
});

test("computeRSISeries approaches 100 for a steady uptrend (no losses)", () => {
  const candles = Array.from({ length: 20 }, (_, i) => candle(i, 100 + i));
  const series = computeRSISeries(candles, 14);
  assert.ok(series.at(-1)! > 95, `expected RSI near 100, got ${series.at(-1)}`);
});

test("computeRSISeries approaches 0 for a steady downtrend (no gains)", () => {
  const candles = Array.from({ length: 20 }, (_, i) => candle(i, 200 - i));
  const series = computeRSISeries(candles, 14);
  assert.ok(series.at(-1)! < 5, `expected RSI near 0, got ${series.at(-1)}`);
});

test("computeRSISeries turns up after a downtrend reverses", () => {
  const down = Array.from({ length: 16 }, (_, i) => candle(i, 200 - i * 3));
  const up = Array.from({ length: 5 }, (_, i) => candle(16 + i, down.at(-1)!.close + i * 4));
  const series = computeRSISeries([...down, ...up], 14);
  const [prev, curr] = series.slice(-2);
  assert.ok(curr > prev, `expected RSI to be turning up, got ${prev} -> ${curr}`);
});
