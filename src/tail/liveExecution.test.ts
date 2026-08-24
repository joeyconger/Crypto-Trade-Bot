import { test } from "node:test";
import assert from "node:assert/strict";
import { drawdownPct, todayUtcDateString } from "./liveExecution.js";

test("drawdownPct: balance up from the snapshot is a negative drawdown", () => {
  assert.equal(drawdownPct(100, 120), -20);
});

test("drawdownPct: balance flat is zero drawdown", () => {
  assert.equal(drawdownPct(100, 100), 0);
});

test("drawdownPct: balance down 10% from the snapshot", () => {
  assert.equal(drawdownPct(100, 90), 10);
});

test("drawdownPct: balance down exactly the cap threshold", () => {
  assert.equal(drawdownPct(1000, 800), 20);
});

test("drawdownPct: balance wiped out is 100% drawdown", () => {
  assert.equal(drawdownPct(500, 0), 100);
});

test("todayUtcDateString: returns a YYYY-MM-DD shaped string", () => {
  assert.match(todayUtcDateString(), /^\d{4}-\d{2}-\d{2}$/);
});
