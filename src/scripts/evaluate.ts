/**
 * Manual smoke-test for the technical + on-chain signal pipeline. Run this
 * wherever the process has real network access (e.g. on Railway) to sanity-check
 * live Birdeye/Helius responses -- `npm run evaluate`. Does not touch signal_log;
 * the full poll loop that persists evaluations lands with the scoring engine.
 */
import { loadWatchlistConfig } from "../config/watchlist.js";
import { evaluateTechnicalSignal } from "../signals/technical.js";
import { evaluateOnchainSignal } from "../signals/onchain.js";

async function main() {
  const config = loadWatchlistConfig();
  const tokens = config.tokens.filter((t) => t.enabled);

  for (const token of tokens) {
    console.log(`\n=== ${token.symbol} (${token.address}) ===`);

    try {
      const technical = await evaluateTechnicalSignal(token);
      console.log(`technical: score=${technical.score.toFixed(2)} -- ${technical.detail}`);

      const onchain = await evaluateOnchainSignal(token, technical.candles);
      console.log(`onchain:   score=${onchain.score.toFixed(2)} -- ${onchain.detail}`);
    } catch (err) {
      console.error(`  failed to evaluate ${token.symbol}:`, err instanceof Error ? err.message : err);
    }
  }
}

main();
