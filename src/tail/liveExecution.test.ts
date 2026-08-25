import { test } from "node:test";
import assert from "node:assert/strict";
import { drawdownPct, todayUtcDateString, serializeLiveExecution } from "./liveExecution.js";

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

// Regression coverage for the concurrency bug: multiple live trades
// executing at once let one trade's real SOL proceeds bleed into another's
// before/after balance measurement, corrupting recorded fill prices (fixed
// by serializing every live buy/sell through this queue). This exercises
// serializeLiveExecution directly with fake timed "trades" rather than real
// executeLiveBuy/executeLiveSell, since those need live RPC/Jupiter access
// this sandbox doesn't have -- same constraint as every other test here.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("serializeLiveExecution: never runs two queued calls concurrently", async () => {
  let concurrentCount = 0;
  let maxConcurrent = 0;

  async function fakeTrade(delayMs: number) {
    concurrentCount++;
    maxConcurrent = Math.max(maxConcurrent, concurrentCount);
    await sleep(delayMs);
    concurrentCount--;
    return delayMs;
  }

  await Promise.all([
    serializeLiveExecution(() => fakeTrade(30)),
    serializeLiveExecution(() => fakeTrade(10)),
    serializeLiveExecution(() => fakeTrade(20)),
  ]);

  assert.equal(maxConcurrent, 1);
});

test("serializeLiveExecution: preserves submission order regardless of individual delays", async () => {
  const order: number[] = [];

  async function fakeTrade(id: number, delayMs: number) {
    order.push(id);
    await sleep(delayMs);
  }

  await Promise.all([
    serializeLiveExecution(() => fakeTrade(1, 30)),
    serializeLiveExecution(() => fakeTrade(2, 5)),
    serializeLiveExecution(() => fakeTrade(3, 15)),
  ]);

  assert.deepEqual(order, [1, 2, 3]);
});

test("serializeLiveExecution: a rejected call doesn't jam the queue for calls behind it", async () => {
  const results = await Promise.allSettled([
    serializeLiveExecution(async () => "ok-1"),
    serializeLiveExecution(async () => {
      throw new Error("trade failed");
    }),
    serializeLiveExecution(async () => "ok-3"),
  ]);

  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[2].status, "fulfilled");
});
