import { env } from "./config/env.js";
import { loadWatchlistConfig } from "./config/watchlist.js";
import { getDb, syncWatchlistTokens } from "./db/index.js";

function main() {
  const config = loadWatchlistConfig();
  getDb();
  syncWatchlistTokens(config);

  const enabledTokens = config.tokens.filter((t) => t.enabled);

  console.log(`Vibes & Fibs — scaffold check`);
  console.log(`  mode: ${env.liveTradingEnabled ? "LIVE" : "paper"}`);
  console.log(`  database: ${env.DATABASE_PATH}`);
  console.log(`  watchlist: ${enabledTokens.length}/${config.tokens.length} tokens enabled`);
  for (const token of enabledTokens) {
    console.log(`    - ${token.symbol} (${token.address})`);
  }
  console.log(`  twitter accounts tracked: ${config.twitterAccounts.length}`);
  console.log(`  risk: max ${config.risk.maxConcurrentPositions} concurrent, ${config.risk.dailyLossLimitPct}% daily loss limit`);
  console.log(`\nStep 1 scaffold OK. Signal engine + execution loop land in later steps.`);
}

main();
