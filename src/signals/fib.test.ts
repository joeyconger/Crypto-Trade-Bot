import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFibLevels, computeFibExtensions, findPivots, findConfirmedSwing, checkGoldenPocket, isWithinZone, pctDistance } from "./fib.js";
import type { OhlcvCandle } from "../data/birdeye.js";

function candle(unixTime: number, o: number, h: number, l: number, c: number, v = 100): OhlcvCandle {
  return { unixTime, open: o, high: h, low: l, close: c, volume: v };
}

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

test("computeFibExtensions projects targets beyond the swing high on an uptrend", () => {
  const swing = { highPrice: 100, highTime: 2, lowPrice: 0, lowTime: 1, direction: "up" as const };
  const extensions = computeFibExtensions(swing, [1.272, 1.618]);
  assert.equal(extensions.find((e) => e.level === 1.272)?.price, 127.2);
  assert.equal(extensions.find((e) => e.level === 1.618)?.price, 161.8);
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

// A 10-candle series with a confirmed pivot low at index 2 (value 5) and a
// confirmed pivot high at index 7 (value 20), each flanked by 2 candles on
// both sides -- a 5-candle fractal (window = 2).
const bullishSwingCandles = [
  candle(0, 9, 10, 9, 10),
  candle(1, 9, 9, 8, 9),
  candle(2, 8, 8, 5, 6), // pivot low
  candle(3, 6, 9, 7, 8),
  candle(4, 8, 10, 8, 9),
  candle(5, 9, 15, 10, 14),
  candle(6, 14, 18, 12, 17),
  candle(7, 17, 20, 14, 19), // pivot high
  candle(8, 19, 17, 13, 15),
  candle(9, 15, 16, 12, 14),
];

test("findConfirmedSwing builds a swing from the most recent confirmed pivots", () => {
  const swing = findConfirmedSwing(bullishSwingCandles, 2);
  assert.ok(swing);
  assert.equal(swing!.direction, "up");
  assert.equal(swing!.lowPrice, 5);
  assert.equal(swing!.highPrice, 20);
});

test("findConfirmedSwing returns undefined without enough pivot-confirming history", () => {
  const swing = findConfirmedSwing(bullishSwingCandles.slice(0, 4), 2);
  assert.equal(swing, undefined);
});

test("checkGoldenPocket passes when price sits at the 0.5 retracement of a confirmed uptrend", () => {
  // swing range 5 -> 20, 0.5 level = 20 - 15*0.5 = 12.5
  const result = checkGoldenPocket(bullishSwingCandles, 12.5, 2, 1);
  assert.equal(result.passed, true);
  assert.equal(result.matchedLevel?.level, 0.5);
});

test("checkGoldenPocket fails when price is nowhere near the golden pocket", () => {
  const result = checkGoldenPocket(bullishSwingCandles, 19.5, 2, 1);
  assert.equal(result.passed, false);
});

test("checkGoldenPocket refuses to chase a confirmed downtrend", () => {
  const bearishCandles = [...bullishSwingCandles].reverse().map((c, i) => ({ ...c, unixTime: i }));
  const result = checkGoldenPocket(bearishCandles, 12.5, 2, 1);
  assert.equal(result.passed, false);
  assert.match(result.reason, /bearish/);
});
