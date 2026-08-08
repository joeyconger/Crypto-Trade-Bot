import { test } from "node:test";
import assert from "node:assert/strict";
import { canOpenPosition, computePositionSizeUsd } from "./risk.js";
import type { RiskConfig } from "../types/index.js";

const risk: RiskConfig = { maxConcurrentPositions: 3, maxPositionSizePct: 10, dailyLossLimitPct: 10 };

test("canOpenPosition blocks when the daily loss limit is breached", () => {
  const result = canOpenPosition(risk, {
    openPositionsCount: 0,
    realizedPnlTodayUsd: -150,
    dailyLossLimitUsd: 100,
    haltedForDailyLoss: true,
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /daily loss limit/);
});

test("canOpenPosition blocks when max concurrent positions is reached", () => {
  const result = canOpenPosition(risk, {
    openPositionsCount: 3,
    realizedPnlTodayUsd: 0,
    dailyLossLimitUsd: 100,
    haltedForDailyLoss: false,
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /max concurrent/);
});

test("canOpenPosition allows when under both limits", () => {
  const result = canOpenPosition(risk, {
    openPositionsCount: 1,
    realizedPnlTodayUsd: 20,
    dailyLossLimitUsd: 100,
    haltedForDailyLoss: false,
  });
  assert.equal(result.allowed, true);
});

test("computePositionSizeUsd caps a token's positionSizePct at the global ceiling", () => {
  // token wants 25%, global ceiling is 10% -> capped
  const size = computePositionSizeUsd({ positionSizePct: 25 }, risk);
  assert.equal(size, 1000 * 0.1); // default PAPER_STARTING_BALANCE_USD is 1000
});

test("computePositionSizeUsd uses the token's own pct when under the ceiling", () => {
  const size = computePositionSizeUsd({ positionSizePct: 5 }, risk);
  assert.equal(size, 1000 * 0.05);
});
