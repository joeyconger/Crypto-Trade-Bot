import { getTopTradedTokens } from "../data/birdeye.js";
import {
  syncWatchlistTokens,
  getWatchlistTokensFromDb,
  getWatchlistLastRefreshedAt,
  setWatchlistLastRefreshedAt,
} from "../db/index.js";
import type { TokenConfig, WatchlistConfig } from "../types/index.js";

function isStale(lastRefreshedAt: string | undefined, refreshIntervalHours: number): boolean {
  if (!lastRefreshedAt) return true;
  const elapsedMs = Date.now() - new Date(lastRefreshedAt).getTime();
  return elapsedMs >= refreshIntervalHours * 60 * 60 * 1000;
}

/**
 * Resolves the current watchlist for this poll cycle.
 *
 * - "static": always the YAML's `tokens` list, synced to the DB every cycle
 *   (cheap, no API calls -- how this worked before top_traded existed).
 * - "top_traded": re-selects the top N tokens by 24h volume from Birdeye once
 *   every `refreshIntervalHours`, each getting the shared `defaultStrategy`.
 *   Between refreshes, and if a refresh attempt itself fails, returns
 *   whatever's already in the DB from the last successful refresh -- a failed
 *   refresh should never leave the bot with zero tokens to trade.
 */
export async function resolveWatchlistTokens(config: WatchlistConfig): Promise<TokenConfig[]> {
  if (config.watchlistSource.mode === "static") {
    syncWatchlistTokens(config.tokens);
    return config.tokens.filter((t) => t.enabled);
  }

  const lastRefreshedAt = getWatchlistLastRefreshedAt();
  if (!isStale(lastRefreshedAt, config.watchlistSource.refreshIntervalHours)) {
    const cached = getWatchlistTokensFromDb();
    if (cached.length > 0) return cached;
    // Cache is empty (e.g. very first run before any successful refresh) -- fall through and force one.
  }

  try {
    const topTraded = await getTopTradedTokens(config.watchlistSource.topTradedCount, config.watchlistSource.minLiquidityUsd);
    if (topTraded.length === 0) {
      throw new Error("Birdeye returned zero top-traded tokens above the liquidity floor");
    }

    const dynamicTokens: TokenConfig[] = topTraded.map((t) => ({
      ...config.defaultStrategy!,
      symbol: t.symbol,
      address: t.address,
      enabled: true,
    }));

    // Static pins (hand-tuned overrides) always ride along, taking priority
    // over a same-address dynamic entry.
    const pinnedAddresses = new Set(config.tokens.map((t) => t.address));
    const merged = [...config.tokens, ...dynamicTokens.filter((t) => !pinnedAddresses.has(t.address))];

    syncWatchlistTokens(merged);
    setWatchlistLastRefreshedAt(new Date().toISOString());
    console.log(`Watchlist refreshed: ${merged.length} tokens (${topTraded.length} top-traded + ${config.tokens.length} pinned)`);
    return merged;
  } catch (err) {
    console.error(
      "Failed to refresh top-traded watchlist, falling back to last known list:",
      err instanceof Error ? err.message : err,
    );
    const cached = getWatchlistTokensFromDb();
    if (cached.length > 0) return cached;

    // Truly nothing to fall back to (e.g. the very first run and Birdeye is down) -- use pins only.
    syncWatchlistTokens(config.tokens);
    return config.tokens.filter((t) => t.enabled);
  }
}
