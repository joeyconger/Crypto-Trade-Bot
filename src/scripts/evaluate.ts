/**
 * Manual smoke-test for the full signal pipeline (technical + on-chain + social
 * -> combined score -> signal_log). Run this wherever the process has real
 * network access (e.g. Railway) to sanity-check live Birdeye/Helius responses
 * -- `npm run evaluate`. The continuous poll loop that also executes trades
 * lands with the paper-trading execution engine.
 */
import { loadWatchlistConfig } from "../config/watchlist.js";
import { getDb, syncWatchlistTokens } from "../db/index.js";
import { evaluateToken, logSignalEvaluation } from "../engine/scoring.js";

async function main() {
  const config = loadWatchlistConfig();
  getDb();
  syncWatchlistTokens(config);

  const tokens = config.tokens.filter((t) => t.enabled);

  for (const token of tokens) {
    console.log(`\n=== ${token.symbol} (${token.address}) ===`);

    try {
      const result = await evaluateToken(token);
      console.log(`  technical: score=${result.technical.score.toFixed(2)} -- ${result.technical.detail}`);
      console.log(`  onchain:   score=${result.onchain.score.toFixed(2)} -- ${result.onchain.detail}`);
      console.log(`  social:    score=${result.social.score.toFixed(2)} -- ${result.social.detail}`);
      console.log(`  combined:  score=${result.combinedScore.toFixed(2)} -> action=${result.action}`);

      const logId = logSignalEvaluation(result);
      console.log(`  logged to signal_log as id=${logId}`);
    } catch (err) {
      console.error(`  failed to evaluate ${token.symbol}:`, err instanceof Error ? err.message : err);
    }
  }
}

main();
