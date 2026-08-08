import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { env } from "./config/env.js";
import { loadWatchlistConfig } from "./config/watchlist.js";
import { getDb, syncWatchlistTokens } from "./db/index.js";
import { startPollLoop } from "./engine/loop.js";
import { startDashboardServer } from "./dashboard/server.js";
import { getBotKeypair } from "./solana/keypair.js";
import { getConnection } from "./solana/connection.js";

async function main() {
  const config = loadWatchlistConfig();
  getDb();
  syncWatchlistTokens(config);

  const enabledTokens = config.tokens.filter((t) => t.enabled);

  console.log(`Vibes & Fibs`);
  console.log(`  mode: ${env.liveTradingEnabled ? "LIVE" : "paper"}`);
  console.log(`  database: ${env.DATABASE_PATH}`);
  console.log(`  watchlist: ${enabledTokens.length}/${config.tokens.length} tokens enabled`);
  for (const token of enabledTokens) {
    console.log(`    - ${token.symbol} (${token.address})`);
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
