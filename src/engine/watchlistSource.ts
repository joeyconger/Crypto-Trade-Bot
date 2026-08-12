import { getTopTradedTokens } from "../data/priceProvider.js";
import {
  syncWatchlistTokens,
  getWatchlistTokensFromDb,
  getWatchlistLastRefreshedAt,
  setWatchlistLastRefreshedAt,
  getWatchlistLastAttemptedAt,
  setWatchlistAttempt,
} from "../db/index.js";
import type { TokenConfig, WatchlistConfig } from "../types/index.js";

function isStale(lastAt: string | undefined, minutes: number): boolean {
  if (!lastAt) return true;
  return Date.now() - new Date(lastAt).getTime() >= minutes * 60 * 1000;
}

function pinsOnly(config: WatchlistConfig): TokenConfig[] {
  syncWatchlistTokens(config.tokens);
  return config.tokens.filter((t) => t.enabled);
}

// If a refresh attempt fails (broken endpoint, sustained rate limiting,
// etc.), wait this long before trying again -- not the full
// refreshIntervalHours, but not every single poll cycle forever either. A
// persistently broken provider endpoint retrying a multi-call burst every 5
// minutes wastes API budget and does nothing but fail the same way again.
const FAILED_REFRESH_RETRY_MINUTES = 30;

/**
 * Resolves the current watchlist for this poll cycle.
 *
 * - "static": always the YAML's `tokens` list, synced to the DB every cycle
 *   (cheap, no API calls -- how this worked before top_traded existed).
 * - "top_traded": re-selects the top N tokens by 24h volume once every
 *   `refreshIntervalHours`, each getting the shared `defaultStrategy`.
 *   Between refreshes, and if a refresh attempt itself fails, returns
 *   whatever's already in the DB from the last successful refresh -- a failed
 *   refresh should never leave the bot with zero tokens to trade.
 */
export async function resolveWatchlistTokens(config: WatchlistConfig): Promise<TokenConfig[]> {
  if (config.watchlistSource.mode === "static") {
    return pinsOnly(config);
  }

  const refreshDue = isStale(getWatchlistLastRefreshedAt(), config.watchlistSource.refreshIntervalHours * 60);
  if (!refreshDue) {
    const cached = getWatchlistTokensFromDb();
    if (cached.length > 0) return cached;
    // Cache is empty (e.g. very first run before any successful refresh) -- fall through and force one.
  }

  if (!isStale(getWatchlistLastAttemptedAt(), FAILED_REFRESH_RETRY_MINUTES)) {
    // A refresh is due, but the last ATTEMPT (successful or not) was recent
    // enough that this is very likely still within a failure backoff window
    // -- don't retry yet, just use whatever's already known.
    const cached = getWatchlistTokensFromDb();
    return cached.length > 0 ? cached : pinsOnly(config);
  }

  setWatchlistAttempt(new Date().toISOString(), null);

  try {
    const topTraded = await getTopTradedTokens(config.watchlistSource.topTradedCount, config.watchlistSource.minLiquidityUsd);
    if (topTraded.length === 0) {
      throw new Error("provider returned zero top-traded tokens above the liquidity floor");
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
    const now = new Date().toISOString();
    setWatchlistLastRefreshedAt(now);
    setWatchlistAttempt(now, null);
    console.log(`Watchlist refreshed: ${merged.length} tokens (${topTraded.length} top-traded + ${config.tokens.length} pinned)`);
    return merged;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Failed to refresh top-traded watchlist, falling back to last known list:", message);
    setWatchlistAttempt(new Date().toISOString(), message);

    const cached = getWatchlistTokensFromDb();
    if (cached.length > 0) return cached;

    // Truly nothing to fall back to (e.g. the very first run and the
    // provider is down) -- use pins only.
    return pinsOnly(config);
  }
}
