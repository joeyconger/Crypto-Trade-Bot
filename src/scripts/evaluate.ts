/**
 * Manual smoke-test for the full trigger-based pipeline (wallet activity
 * polling -> on-chain trigger -> fib filter -> entry/exit management) --
 * runs exactly one poll cycle and exits, without waiting for
 * POLL_INTERVAL_SECONDS. Run this wherever the process has real network
 * access (e.g. Railway) to sanity-check live Birdeye/Helius responses --
 * `npm run evaluate`. Check the console output and the dashboard's Signal
 * History afterward for what fired and why.
 */
import { getDb } from "../db/index.js";
import { runPollCycle } from "../engine/loop.js";

async function main() {
  getDb();
  await runPollCycle();
}

main().catch((err) => {
  console.error("Evaluation cycle failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
