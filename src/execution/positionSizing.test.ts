import { test } from "node:test";
import assert from "node:assert/strict";
import { computePositionSize, computeInitialStop } from "./positionSizing.js";

test("computePositionSize risks exactly riskPct of account when under the max-position cap", () => {
  // account $1000, risk 1% = $10. entry 10, stop 9 -> stop distance 1.
  // quantity = riskUsd / stopDistance = 10 tokens. usdSize = 10 * 10 = $100 (10% of account).
  const result = computePositionSize(1000, 10, 9, 1, 50);
  assert.equal(result.usdSize, 100);
  assert.equal(result.quantity, 10);
  assert.equal(result.cappedByMaxPosition, false);
});

test("computePositionSize caps at maxPositionSizePct regardless of stop distance", () => {
  // Very tight stop (entry 10, stop 9.9 -> distance 0.1) would imply a huge
  // size (riskUsd=10 / 0.1 * 10 = $1000, 100% of account) -- the 10% cap wins.
  const result = computePositionSize(1000, 10, 9.9, 1, 10);
  assert.equal(result.usdSize, 100); // 10% of $1000
  assert.equal(result.cappedByMaxPosition, true);
});

test("computePositionSize throws when the stop isn't below entry", () => {
  assert.throws(() => computePositionSize(1000, 10, 10, 1, 10));
  assert.throws(() => computePositionSize(1000, 10, 11, 1, 10));
});

test("computeInitialStop subtracts ATR x multiplier from the swing low", () => {
  assert.equal(computeInitialStop(100, 5, 1), 95);
  assert.equal(computeInitialStop(100, 5, 2), 90);
});
