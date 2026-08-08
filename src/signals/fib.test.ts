import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFibLevels, findPivots, findSwing, isWithinZone, pctDistance } from "./fib.js";
import type { OhlcvCandle } from "../data/birdeye.js";

function candle(unixTime: number, o: number, h: number, l: number, c: number, v = 100): OhlcvCandle {
  return { unixTime, open: o, high: h, low: l, close: c, volume: v };
}

test("findSwing detects an uptrend when the low precedes the high", () => {
  const candles = [candle(1, 10, 10, 8, 9), candle(2, 9, 20, 9, 19), candle(3, 19, 19, 15, 16)];
  const swing = findSwing(candles);
  assert.equal(swing.direction, "up");
  assert.equal(swing.lowPrice, 8);
  assert.equal(swing.highPrice, 20);
});

test("findSwing detects a downtrend when the high precedes the low", () => {
  const candles = [candle(1, 10, 20, 10, 19), candle(2, 19, 19, 12, 13), candle(3, 13, 13, 5, 6)];
  const swing = findSwing(candles);
  assert.equal(swing.direction, "down");
  assert.equal(swing.highPrice, 20);
  assert.equal(swing.lowPrice, 5);
});

test("computeFibLevels places support levels below the high on an uptrend", () => {
  const swing = { highPrice: 100, highTime: 2, lowPrice: 0, lowTime: 1, direction: "up" as const };
  const levels = computeFibLevels(swing, [0.5, 0.618]);
  assert.equal(levels.find((l) => l.level === 0.5)?.price, 50);
  assert.equal(levels.find((l) => l.level === 0.618)?.price, 38.2);
});

test("computeFibLevels places resistance levels above the low on a downtrend", () => {
  const swing = { highPrice: 100, highTime: 1, lowPrice: 0, lowTime: 2, direction: "down" as const };
  const levels = computeFibLevels(swing, [0.5, 0.618]);
  assert.equal(levels.find((l) => l.level === 0.5)?.price, 50);
  assert.equal(levels.find((l) => l.level === 0.618)?.price, 61.8);
});

test("isWithinZone / pctDistance agree on the zone boundary", () => {
  assert.equal(Math.round(pctDistance(101, 100) * 100) / 100, 1);
  assert.ok(isWithinZone(101, 100, 1.5));
  assert.ok(!isWithinZone(102, 100, 1.5));
});

test("findPivots flags a local extreme surrounded by lower highs / higher lows", () => {
  const candles = [
    candle(1, 10, 10, 9, 10),
    candle(2, 10, 11, 10, 11),
    candle(3, 11, 15, 11, 12), // pivot high
    candle(4, 12, 11, 10, 11),
    candle(5, 11, 10, 9, 10),
  ];
  const pivots = findPivots(candles, 2);
  assert.ok(pivots.some((p) => p.type === "high" && p.price === 15));
});
