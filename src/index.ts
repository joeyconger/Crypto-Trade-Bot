import { env } from "./config/env.js";
import { loadWatchlistConfig } from "./config/watchlist.js";
import { getDb, syncWatchlistTokens } from "./db/index.js";
import { startPollLoop } from "./engine/loop.js";

function main() {
  const config = loadWatchlistConfig();
  getDb();
  syncWatchlistTokens(config);

  const enabledTokens = config.tokens.filter((t) => t.enabled);

  if (env.liveTradingEnabled) {
    // Live execution (Jupiter swap + signing) doesn't exist yet -- refuse to
    // start rather than silently running paper logic under a "LIVE" label.
    console.error(
      "LIVE_TRADING is enabled, but live execution isn't implemented yet -- refusing to start. Set LIVE_TRADING=false to run in paper mode.",
    );
    process.exit(1);
  }

  console.log(`Vibes & Fibs`);
  console.log(`  mode: paper`);
  console.log(`  paper starting balance: $${env.PAPER_STARTING_BALANCE_USD}`);
  console.log(`  database: ${env.DATABASE_PATH}`);
  console.log(`  watchlist: ${enabledTokens.length}/${config.tokens.length} tokens enabled`);
  for (const token of enabledTokens) {
    console.log(`    - ${token.symbol} (${token.address})`);
  }
  console.log(`  risk: max ${config.risk.maxConcurrentPositions} concurrent, ${config.risk.dailyLossLimitPct}% daily loss limit`);
  console.log(`  poll interval: ${env.POLL_INTERVAL_SECONDS}s\n`);

  startPollLoop(env.POLL_INTERVAL_SECONDS);
}

main();
