import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { env } from "./config/env.js";
import { loadWatchlistConfig } from "./config/watchlist.js";
import { getDb } from "./db/index.js";
import { startPollLoop } from "./engine/loop.js";
import { startDashboardServer } from "./dashboard/server.js";
import { getBotKeypair } from "./solana/keypair.js";
import { getConnection } from "./solana/connection.js";
import { loadTailConfig } from "./tail/config.js";
import { initTailSchema, upsertTailWallet, getActiveTailWalletAddresses } from "./tail/db.js";
import { logStartupCoverageGapIfAny } from "./tail/webhook.js";

// Per technical-trigger scan (OHLCV fetch + fib/RSI/volume/close checks) for
// a token with no open position: one price-provider OHLCV call, one Helius
// wallet-activity poll. Current price is batched separately via
// getMultiPrice, amortized across a whole due-batch rather than 1-per-token.
// Excludes per-cycle checks on tokens with an open position (bounded by how
// many positions are open, not watchlist size) and the liquidity/on-chain
// lookups Condition 7 needs (only spent on tokens that already cleared
// Conditions 1-6, a small fraction of all scans).
const OHLCV_CALLS_PER_SCAN = 1;
const HELIUS_CALLS_PER_SCAN = 1;
// GeckoTerminal's multi-token batch caps at 30 addresses/call; Birdeye's is
// larger (100), so this is the conservative (GeckoTerminal) assumption --
// accurate for the default provider, an overestimate if running on Birdeye.
const PRICE_BATCH_CHUNK_SIZE = 30;

interface RefreshBucket {
  count: number;
  technicalRefreshIntervalMinutes: number;
}

function logApiUsageEstimate(buckets: RefreshBucket[]): void {
  const totalTokens = buckets.reduce((sum, b) => sum + b.count, 0);
  let ohlcvPerDay = 0;
  let priceBatchPerDay = 0;
  let heliusPerDay = 0;

  for (const bucket of buckets) {
    if (bucket.count === 0) continue;
    const scansPerDay = (24 * 60) / bucket.technicalRefreshIntervalMinutes;
    ohlcvPerDay += bucket.count * scansPerDay * OHLCV_CALLS_PER_SCAN;
    heliusPerDay += bucket.count * scansPerDay * HELIUS_CALLS_PER_SCAN;
    priceBatchPerDay += Math.ceil(bucket.count / PRICE_BATCH_CHUNK_SIZE) * scansPerDay;
  }

  const providerCallsPerDay = Math.round(ohlcvPerDay + priceBatchPerDay);
  const heliusPerDayRounded = Math.round(heliusPerDay);
  // What matters for a per-minute-rate-limited provider (GeckoTerminal) is
  // this sustained rate, not the daily/monthly total -- engine/loop.ts's
  // per-tick scan budget is specifically what spreads load evenly enough to
  // make "sustained" the right word instead of "bursty."
  const sustainedCallsPerMin = providerCallsPerDay / (24 * 60);

  console.log(
    `  estimated price-provider usage: ~${providerCallsPerDay.toLocaleString()}/day, ~${sustainedCallsPerMin.toFixed(1)}/min sustained ` +
      `(if spread evenly per engine/loop.ts's scan budget) -- ~${Math.round((providerCallsPerDay * 30) / 1000)}k/month`,
  );
  console.log(
    `    (${totalTokens} tokens; check the sustained rate against GeckoTerminal's ~30/min free-tier limit, or the monthly figure against Birdeye's quota if PRICE_PROVIDER=birdeye)`,
  );
  console.log(`    ~${heliusPerDayRounded.toLocaleString()} Helius calls/day (excludes on-chain confluence's own per-candidate wallet lookups)`);
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
    `  risk: ${config.risk.riskPctPerTrade}% (Tier A) / ${config.risk.riskPctPerTradeTierB}% (Tier B) per trade, ` +
      `${config.risk.dailyLossLimitPct}% daily / ${config.risk.weeklyLossLimitPct}% weekly loss limit, ` +
      `${config.risk.consecutiveLossLimit}-loss streak halt, max ${config.risk.maxConcurrentPositions} concurrent positions`,
  );
  console.log(`  price provider: ${env.PRICE_PROVIDER}`);
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

  const tailConfig = loadTailConfig();
  if (tailConfig.enabled) {
    initTailSchema();
    // Seeds tail_wallets from env on a fresh database, or picks up an
    // address added directly to Railway's env vars -- a no-op for any
    // address already there (e.g. previously added via the dashboard).
    for (const address of tailConfig.envSeedWalletAddresses) {
      upsertTailWallet(address, tailConfig.envSeedWalletLabels.get(address) ?? null);
    }
    const activeWallets = getActiveTailWalletAddresses();
    logStartupCoverageGapIfAny(activeWallets);
    console.log(
      `  wallet-tail (research, paper-only): watching ${activeWallets.length} wallet(s) (DB-managed -- add/remove via the dashboard), ` +
        `${tailConfig.positionSizePct}% sizing, ${tailConfig.simulatedDelaySeconds}s simulated delay, ` +
        `$${tailConfig.startingBalanceUsd} own paper balance -- register the Helius webhook at POST /api/tail/webhook (see README)`,
    );
  }
  console.log("");

  startDashboardServer();
  startPollLoop(env.POLL_INTERVAL_SECONDS);
}

main().catch((err) => {
  console.error("Fatal startup error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
