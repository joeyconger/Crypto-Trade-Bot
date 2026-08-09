import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { env } from "./config/env.js";
import { loadWatchlistConfig } from "./config/watchlist.js";
import { getDb } from "./db/index.js";
import { startPollLoop } from "./engine/loop.js";
import { startDashboardServer } from "./dashboard/server.js";
import { getBotKeypair } from "./solana/keypair.js";
import { getConnection } from "./solana/connection.js";

// Per technical-trigger scan (OHLCV fetch + fib/RSI/volume/close checks) for
// a token with no open position: one Birdeye OHLCV call, one Helius
// wallet-activity poll. Price is batched separately via getMultiPrice, so
// it's amortized across a whole due-batch rather than 1-per-token. Excludes
// per-cycle checks on tokens with an open position (bounded by how many
// positions are open, not watchlist size) and occasional on-chain-confluence
// liquidity lookups (only on a technical-trigger fire).
const BIRDEYE_OHLCV_CALLS_PER_SCAN = 1;
const HELIUS_CALLS_PER_SCAN = 1;
const MULTI_PRICE_CHUNK_SIZE = 100;

interface RefreshBucket {
  count: number;
  technicalRefreshIntervalMinutes: number;
}

function logApiUsageEstimate(buckets: RefreshBucket[]): void {
  const totalTokens = buckets.reduce((sum, b) => sum + b.count, 0);
  let ohlcvPerDay = 0;
  let multiPricePerDay = 0;
  let heliusPerDay = 0;

  for (const bucket of buckets) {
    if (bucket.count === 0) continue;
    const scansPerDay = (24 * 60) / bucket.technicalRefreshIntervalMinutes;
    ohlcvPerDay += bucket.count * scansPerDay * BIRDEYE_OHLCV_CALLS_PER_SCAN;
    heliusPerDay += bucket.count * scansPerDay * HELIUS_CALLS_PER_SCAN;
    multiPricePerDay += Math.ceil(bucket.count / MULTI_PRICE_CHUNK_SIZE) * scansPerDay;
  }

  const birdeyePerDay = Math.round(ohlcvPerDay + multiPricePerDay);
  const heliusPerDayRounded = Math.round(heliusPerDay);

  console.log(
    `  estimated API usage: ~${birdeyePerDay.toLocaleString()} Birdeye calls/day (~${Math.round((birdeyePerDay * 30) / 1000)}k/month), ~${heliusPerDayRounded.toLocaleString()} Helius calls/day`,
  );
  console.log(
    `    (${totalTokens} tokens, technical scans throttled per-token via technicalRefreshIntervalMinutes -- excludes open-position management and on-chain-confluence lookups; check against your actual plan limits)`,
  );
}

async function main() {
  const config = loadWatchlistConfig();
  getDb();

  console.log(`Vibes & Fibs`);
  console.log(`  mode: ${env.liveTradingEnabled ? "LIVE" : "paper"}`);
  console.log(`  database: ${env.DATABASE_PATH}`);

  if (config.watchlistSource.mode === "top_traded") {
    console.log(
      `  watchlist: top ${config.watchlistSource.topTradedCount} by 24h volume (refreshed every ${config.watchlistSource.refreshIntervalHours}h)` +
        (config.tokens.length > 0 ? ` + ${config.tokens.length} pinned` : "") +
        ` -- populated on first poll cycle`,
    );
    logApiUsageEstimate([
      { count: config.watchlistSource.topTradedCount, technicalRefreshIntervalMinutes: config.defaultStrategy!.technicalRefreshIntervalMinutes },
      ...config.tokens.map((t) => ({ count: 1, technicalRefreshIntervalMinutes: t.technicalRefreshIntervalMinutes })),
    ]);
  } else {
    const enabledTokens = config.tokens.filter((t) => t.enabled);
    console.log(`  watchlist: ${enabledTokens.length}/${config.tokens.length} tokens enabled (static)`);
    for (const token of enabledTokens) {
      console.log(`    - ${token.symbol} (${token.address})`);
    }
    logApiUsageEstimate(enabledTokens.map((t) => ({ count: 1, technicalRefreshIntervalMinutes: t.technicalRefreshIntervalMinutes })));
  }

  console.log(
    `  risk: ${config.risk.riskPctPerTrade}% per trade, ${config.risk.dailyLossLimitPct}% daily / ${config.risk.weeklyLossLimitPct}% weekly loss limit, ${config.risk.consecutiveLossLimit}-loss streak halt`,
  );
  console.log(`  poll interval: ${env.POLL_INTERVAL_SECONDS}s`);

  if (env.liveTradingEnabled) {
    // getBotKeypair() throws if BOT_PRIVATE_KEY is missing/invalid -- fail
    // fast and loudly rather than starting a live bot with no signer.
    const keypair = getBotKeypair();
    const connection = getConnection();
    const lamports = await connection.getBalance(keypair.publicKey);
    const solBalance = lamports / LAMPORTS_PER_SOL;

    console.log(`\n*** LIVE TRADING ENABLED -- real transactions will be signed and sent ***`);
    console.log(`  bot wallet: ${keypair.publicKey.toBase58()}`);
    console.log(`  balance: ${solBalance.toFixed(4)} SOL`);
    if (solBalance === 0) {
      console.warn(`  wallet has zero balance -- fund it from Phantom before the bot can open any positions.`);
    }
  } else {
    console.log(`  paper starting balance: $${env.PAPER_STARTING_BALANCE_USD}`);
  }
  console.log("");

  startDashboardServer();
  startPollLoop(env.POLL_INTERVAL_SECONDS);
}

main().catch((err) => {
  console.error("Fatal startup error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
