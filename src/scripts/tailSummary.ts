/**
 * On-demand wallet-tail summary -- `npm run tail-summary` (optionally
 * `-- --days 7` to scope the window, default: all recorded trades).
 * Prints the same numbers the dashboard's wallet-tail section shows,
 * for pasting into a report or checking without opening the UI.
 */
import { getDb } from "../db/index.js";
import { initTailSchema, getAllTailTrades, getTailTradesSince, getRecentTailCoverageGaps } from "../tail/db.js";
import { computeTailSummary } from "../tail/summary.js";

function parseArgs(argv: string[]): { days: number | undefined } {
  let days: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") days = Number(argv[++i]);
  }
  return { days };
}

function pct(n: number | null): string {
  return n == null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function usd(n: number): string {
  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}

function ms(n: number | null): string {
  return n == null ? "n/a" : n < 1000 ? `${n.toFixed(0)}ms` : `${(n / 1000).toFixed(1)}s`;
}

function main() {
  getDb();
  initTailSchema();

  const args = parseArgs(process.argv.slice(2));
  const trades = args.days
    ? getTailTradesSince(new Date(Date.now() - args.days * 86400 * 1000).toISOString())
    : getAllTailTrades(undefined, 5000);

  const summary = computeTailSummary(trades);

  console.log("=".repeat(70));
  console.log(`WALLET-TAIL SUMMARY${args.days ? ` -- last ${args.days}d` : " -- all recorded trades"}`);
  console.log("research/paper-only -- not part of the main strategy's results");
  console.log("=".repeat(70));
  console.log(`closed trades: ${summary.tradeCount}  |  open: ${summary.openCount}  |  unfillable (entry/exit): ${summary.unfillableEntryCount}/${summary.unfillableExitCount}`);
  console.log(`win rate: ${summary.winRate == null ? "n/a" : summary.winRate.toFixed(1) + "%"}`);
  console.log("");
  console.log("realistic simulated fills (lagged, the honest answer):");
  console.log(`  total simulated P&L: ${usd(summary.totalSimulatedPnlUsd)}`);
  console.log("");
  console.log("if filled at the wallet's exact price/time instead:");
  console.log(`  total P&L: ${usd(summary.totalWalletExactPnlUsd)}`);
  console.log("");
  console.log(`lag cost (exact-fill P&L minus realistic P&L): ${usd(summary.lagCostUsd)}`);
  console.log(`  ${summary.lagCostUsd > 0 ? "-- lag cost real money vs. instant execution" : "-- lag didn't cost money over this sample (unusual; check sample size before trusting it)"}`);
  console.log("");
  console.log(`avg entry detection latency: ${ms(summary.avgEntryDetectionLatencyMs)}`);
  console.log(`avg exit detection latency: ${ms(summary.avgExitDetectionLatencyMs)}`);
  console.log(`avg entry slippage vs. wallet: ${pct(summary.avgEntrySlippageVsWalletPct)}`);
  console.log(`avg exit slippage vs. wallet: ${pct(summary.avgExitSlippageVsWalletPct)}`);

  const gaps = getRecentTailCoverageGaps(20);
  if (gaps.length > 0) {
    console.log("");
    console.log(`coverage gaps recorded (${gaps.length}, most recent first):`);
    for (const g of gaps) {
      console.log(`  [${g.detected_at}] ${g.reason}: ${g.detail}`);
    }
  }

  console.log("");
  console.log("Reminder: this is a paper-only research module testing whether copy-tailing");
  console.log("this wallet is viable. Nothing here reflects the main strategy's results.");
}

main();
