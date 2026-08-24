import { env } from "./config/env.js";
import { getDb } from "./db/index.js";
import { startDashboardServer } from "./dashboard/server.js";
import { loadTailConfig } from "./tail/config.js";
import { initTailSchema, upsertTailWallet, getActiveTailWalletAddresses } from "./tail/db.js";
import { logStartupCoverageGapIfAny } from "./tail/webhook.js";

async function main() {
  getDb();

  console.log(`Vibes & Fibs`);
  console.log(`  database: ${env.DATABASE_PATH}`);

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

    if (tailConfig.liveTradingEnabled) {
      console.log(`\n*** WALLET-TAIL LIVE TRADING ENABLED -- real transactions will be signed and sent ***`);
      console.log(
        `  watching ${activeWallets.length} wallet(s) (DB-managed -- add/remove via the dashboard), ` +
          `${tailConfig.positionSizePct}% of live balance per trade, ${tailConfig.liveSlippageBps / 100}% slippage tolerance, ` +
          `${tailConfig.liveDailyLossLimitPct}% daily loss cap`,
      );
    } else {
      console.log(
        `  wallet-tail (paper): watching ${activeWallets.length} wallet(s) (DB-managed -- add/remove via the dashboard), ` +
          `${tailConfig.positionSizePct}% sizing, ${tailConfig.simulatedDelaySeconds}s simulated delay, ` +
          `$${tailConfig.startingBalanceUsd} paper balance -- register the Helius webhook at POST /api/tail/webhook (see README)`,
      );
    }
  } else {
    console.log(`  wallet-tail: disabled (TAIL_ENABLED unset/false)`);
  }
  console.log("");

  startDashboardServer();
}

main().catch((err) => {
  console.error("Fatal startup error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
