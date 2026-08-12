/**
 * Backtest CLI -- `npm run backtest -- --days 90`
 *
 * Requires real network access to the configured PRICE_PROVIDER (this
 * sandbox has none -- every run attempted while building this returned a
 * network error, which is expected here and not a bug). Run this from
 * somewhere with real network access (locally, or a Railway shell) before
 * putting live capital behind this strategy.
 *
 * ============================================================================
 * READ THIS BEFORE TRUSTING ANY NUMBER THIS PRINTS
 * ============================================================================
 * This backtest simulates Conditions 1-6 (the technical trigger) ONLY.
 * Condition 7 (on-chain confluence) is REQUIRED in the live/paper bot --
 * src/onchain/entryTrigger.ts -- and is NOT simulated here. Reproducing it
 * historically would need per-wallet buy/sell data at the specific moments
 * being tested, plus that wallet's reputation AS OF that historical moment
 * (not its current one, which would be look-ahead bias) -- data this
 * sandbox cannot fetch and that's expensive to gather even with live access
 * (Helius per-wallet history lookups, at volume, across months of data).
 *
 * That means:
 *   - Every trade below assumes Condition 7 would ALSO have fired. In the
 *     real bot, most technical setups never get on-chain confirmation at
 *     all -- so real trade frequency will be LOWER than what's reported
 *     here, likely substantially.
 *   - There is no Tier A/Tier B split in these results, because there's no
 *     simulated on-chain confirmation to derive a tier from. Every backtest
 *     trade is sized at the base riskPctPerTrade, not the tier-dependent
 *     sizing the live bot actually uses.
 *   - This is a diagnostic on the TECHNICAL filter's entry-timing quality,
 *     not a validation of the deployed strategy's actual performance.
 *
 * The practical way to validate the full strategy (including Condition 7)
 * is forward paper-trading -- paper mode runs the EXACT same code path as
 * live, just simulated fills, so its trade set is the real one. See
 * README's "Backtesting before live capital" section.
 * ============================================================================
 */
import { loadWatchlistConfig } from "../config/watchlist.js";
import { env } from "../config/env.js";
import { fetchHistoricalCandles } from "./fetchHistory.js";
import { runBacktest, type BacktestResult } from "./engine.js";
import type { TokenConfig } from "../types/index.js";

interface CliArgs {
  days: number;
  addresses: string[] | undefined; // undefined = use pinned tokens from config
  feeBps: number;
  slippageBps: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { days: 90, addresses: undefined, feeBps: 30, slippageBps: 100 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--days") args.days = Number(argv[++i]);
    else if (arg === "--tokens") args.addresses = argv[++i].split(",").map((s) => s.trim());
    else if (arg === "--fee-bps") args.feeBps = Number(argv[++i]);
    else if (arg === "--slippage-bps") args.slippageBps = Number(argv[++i]);
  }
  return args;
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function usd(n: number): string {
  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}

function summarize(symbol: string, result: BacktestResult, startingBankrollUsd: number) {
  const { trades, finalBankrollUsd, maxDrawdownPct, buyAndHoldReturnPct } = result;
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const netReturnPct = ((finalBankrollUsd - startingBankrollUsd) / startingBankrollUsd) * 100;

  console.log(`\n--- ${symbol} ---`);
  console.log(`  trades: ${trades.length} (${wins.length} win / ${losses.length} loss, ${winRate.toFixed(1)}% win rate)`);
  console.log(`  avg win: ${pct(avgWinPct)}   avg loss: ${pct(avgLossPct)}`);
  console.log(`  net return (technical-only, fees+slippage applied): ${pct(netReturnPct)} (${usd(finalBankrollUsd - startingBankrollUsd)})`);
  console.log(`  max drawdown: ${maxDrawdownPct.toFixed(2)}%`);
  console.log(`  buy-and-hold over the same window: ${pct(buyAndHoldReturnPct)}`);
  console.log(`  beat buy-and-hold: ${netReturnPct > buyAndHoldReturnPct ? "YES" : "NO"}`);

  return { symbol, trades: trades.length, winRate, netReturnPct, buyAndHoldReturnPct, maxDrawdownPct };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadWatchlistConfig();

  const tokensToTest: TokenConfig[] = args.addresses
    ? args.addresses.map((address) => {
        const pinned = config.tokens.find((t) => t.address === address);
        if (pinned) return pinned;
        if (!config.defaultStrategy) {
          throw new Error(`--tokens address ${address} isn't a pinned token and no defaultStrategy is configured to fall back to`);
        }
        return { ...config.defaultStrategy, symbol: address.slice(0, 6), address, enabled: true };
      })
    : config.tokens;

  if (tokensToTest.length === 0) {
    throw new Error("No tokens to backtest -- pass --tokens <address1,address2,...> or configure pinned tokens in watchlist.yaml");
  }

  console.log("=".repeat(78));
  console.log("BACKTEST -- TECHNICAL CONDITIONS 1-6 ONLY. Condition 7 (on-chain");
  console.log("confluence) is NOT simulated -- see the header comment in this file");
  console.log("and README's 'Backtesting before live capital' section before trusting");
  console.log("any number below as what the deployed bot would actually have done.");
  console.log("=".repeat(78));
  console.log(`provider: ${env.PRICE_PROVIDER}  |  window: ${args.days}d  |  fee: ${args.feeBps}bps  |  slippage: ${args.slippageBps}bps`);
  console.log(`tokens: ${tokensToTest.map((t) => t.symbol).join(", ")}`);

  const toUnix = Math.floor(Date.now() / 1000);
  const fromUnix = toUnix - args.days * 86400;
  const startingBankrollUsd = env.PAPER_STARTING_BALANCE_USD;

  const summaries: ReturnType<typeof summarize>[] = [];

  for (const token of tokensToTest) {
    try {
      const candles = await fetchHistoricalCandles(token.address, token.swingLookbackHours, fromUnix, toUnix);
      if (candles.length < 50) {
        console.log(`\n--- ${token.symbol} --- skipped: only ${candles.length} candles returned, not enough to backtest meaningfully`);
        continue;
      }
      const result = runBacktest(token, candles, {
        startingBankrollUsd,
        feeBps: args.feeBps,
        slippageBps: args.slippageBps,
      });
      summaries.push(summarize(token.symbol, result, startingBankrollUsd));
    } catch (err) {
      console.error(`\n--- ${token.symbol} --- FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (summaries.length > 1) {
    console.log(`\n${"=".repeat(78)}`);
    console.log("AGGREGATE (technical-only, unweighted average across tokens)");
    console.log("=".repeat(78));
    const avg = (f: (s: (typeof summaries)[number]) => number) => summaries.reduce((s, x) => s + f(x), 0) / summaries.length;
    console.log(`  total trades: ${summaries.reduce((s, x) => s + x.trades, 0)}`);
    console.log(`  avg win rate: ${avg((s) => s.winRate).toFixed(1)}%`);
    console.log(`  avg net return: ${pct(avg((s) => s.netReturnPct))}`);
    console.log(`  avg buy-and-hold: ${pct(avg((s) => s.buyAndHoldReturnPct))}`);
    console.log(`  avg max drawdown: ${avg((s) => s.maxDrawdownPct).toFixed(2)}%`);
  }

  console.log(`\nReminder: this is a Conditions-1-6-only diagnostic, not a validation of the deployed strategy. See the header of src/backtest/run.ts.`);
}

main().catch((err) => {
  console.error("Backtest failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
