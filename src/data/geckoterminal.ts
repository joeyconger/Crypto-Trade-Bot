import { env } from "../config/env.js";
import { getCachedPoolAddress, setCachedPoolAddress } from "../db/index.js";
import type { OhlcvCandle, TokenOverview, TopTradedToken } from "./types.js";

/**
 * GeckoTerminal's public API -- no API key/signup required to use it at all,
 * unlike Birdeye. Used as the fallback price/OHLCV provider when Birdeye's
 * quota is exhausted (see PRICE_PROVIDER in config/env.ts). Field shapes
 * below are my best understanding of GeckoTerminal's documented v2 API and
 * are UNVERIFIED from this sandbox (no live network access) -- check the raw
 * error message on the first live run before assuming the strategy logic is
 * at fault, same caveat as every Birdeye endpoint in data/birdeye.ts.
 *
 * Fully anonymous requests (no key) share a rate-limit pool with every other
 * unauthenticated caller hitting GeckoTerminal worldwide, not just this bot
 * -- in practice that's noticeably worse than "30 req/min for us." Setting
 * GECKOTERMINAL_API_KEY to a free CoinGecko "Demo" key (not a paid plan --
 * no cost, no credit card, just a signup at coingecko.com/en/api/pricing)
 * gets a dedicated per-key allowance instead, sent via the x-cg-demo-api-key
 * header per CoinGecko's public docs. Strongly recommended; the bot works
 * without one, just more prone to 429s under load.
 */

const BASE_URL = "https://api.geckoterminal.com/api/v2";
const NETWORK = "solana";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headers(): Record<string, string> {
  const base: Record<string, string> = { accept: "application/json" };
  if (env.GECKOTERMINAL_API_KEY) base["x-cg-demo-api-key"] = env.GECKOTERMINAL_API_KEY;
  return base;
}

// A 429 here usually means a shared rate-limit window is exhausted, not that
// this one request was malformed -- a couple of quick retries rarely help,
// so this backs off meaningfully (up to ~30s across 4 retries) rather than
// hammering the same window. If it still fails, the caller (engine/loop.ts)
// logs it to signal_log and just picks the token back up next poll cycle --
// a missed cycle here is cheap, so this isn't trying to force success.
async function gtGet(path: string, params: Record<string, string> = {}, retries = 4): Promise<any> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { headers: headers() });

    if (res.status === 429 && attempt < retries) {
      await sleep(3000 * Math.pow(1.8, attempt));
      continue;
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(`GeckoTerminal request to ${path} failed (${res.status}): ${bodyText.slice(0, 500)}`);
    }

    return res.json();
  }

  throw new Error(`GeckoTerminal request to ${path} failed after ${retries} retries (rate limited)`);
}

function stripNetworkPrefix(id: string): string {
  return id.startsWith(`${NETWORK}_`) ? id.slice(NETWORK.length + 1) : id;
}

/**
 * The pool an OHLCV request needs -- GeckoTerminal's candle endpoint is
 * scoped to a specific liquidity pool, not a token mint directly. Resolves
 * and caches the token's most liquid pool (by reserve_in_usd) so this is
 * only a network call the first time a given token is seen.
 */
async function resolvePoolAddress(tokenAddress: string): Promise<string> {
  const cached = getCachedPoolAddress(tokenAddress);
  if (cached) return cached;

  const body = await gtGet(`/networks/${NETWORK}/tokens/${tokenAddress}/pools`, { page: "1" });
  const pools = (body?.data ?? []) as any[];
  if (pools.length === 0) {
    throw new Error(`GeckoTerminal returned no pools for token ${tokenAddress}`);
  }

  const best = pools.reduce((a, b) =>
    Number(b?.attributes?.reserve_in_usd ?? 0) > Number(a?.attributes?.reserve_in_usd ?? 0) ? b : a,
  );
  const poolAddress = best?.attributes?.address;
  if (!poolAddress) throw new Error(`GeckoTerminal pool for token ${tokenAddress} has no address field`);

  setCachedPoolAddress(tokenAddress, poolAddress);
  return poolAddress;
}

interface Timeframe {
  timeframe: "minute" | "hour" | "day";
  aggregate: number;
  candleSeconds: number;
}

// Mirrors birdeye.ts's pickOhlcvInterval, mapped onto GeckoTerminal's
// {timeframe, aggregate} scheme -- aggregate values kept within GT's
// documented valid sets (minute: 1/5/15, hour: 1/4/12, day: 1).
function pickTimeframe(lookbackHours: number): Timeframe {
  if (lookbackHours <= 12) return { timeframe: "minute", aggregate: 5, candleSeconds: 5 * 60 };
  if (lookbackHours <= 48) return { timeframe: "minute", aggregate: 15, candleSeconds: 15 * 60 };
  if (lookbackHours <= 24 * 14) return { timeframe: "hour", aggregate: 1, candleSeconds: 3600 };
  return { timeframe: "hour", aggregate: 4, candleSeconds: 4 * 3600 };
}

const MAX_OHLCV_LIMIT = 1000;

export async function getOhlcv(
  address: string,
  swingLookbackHours: number,
  timeFrom: number,
  timeTo: number,
): Promise<OhlcvCandle[]> {
  const poolAddress = await resolvePoolAddress(address);
  const { timeframe, aggregate, candleSeconds } = pickTimeframe(swingLookbackHours);
  const limit = Math.min(MAX_OHLCV_LIMIT, Math.max(1, Math.ceil((timeTo - timeFrom) / candleSeconds)));

  const body = await gtGet(`/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${timeframe}`, {
    aggregate: String(aggregate),
    limit: String(limit),
    before_timestamp: String(timeTo),
  });

  const list = (body?.data?.attributes?.ohlcv_list ?? []) as number[][];
  return list
    .map(([unixTime, open, high, low, close, volume]) => ({ unixTime, open, high, low, close, volume }))
    .filter((c) => c.unixTime >= timeFrom);
}

export async function getTokenOverview(address: string): Promise<TokenOverview> {
  const body = await gtGet(`/networks/${NETWORK}/tokens/${address}`, { include: "top_pools" });
  const attrs = body?.data?.attributes ?? {};

  // Opportunistically cache the primary pool from the same response so a
  // later getOhlcv call for this token doesn't need its own resolution call.
  const topPools = (body?.included ?? []).filter((item: any) => item?.type === "pool");
  if (topPools.length > 0) {
    const best = topPools.reduce((a: any, b: any) =>
      Number(b?.attributes?.reserve_in_usd ?? 0) > Number(a?.attributes?.reserve_in_usd ?? 0) ? b : a,
    );
    if (best?.attributes?.address) setCachedPoolAddress(address, best.attributes.address);
  }

  return {
    price: Number(attrs?.price_usd ?? 0),
    liquidityUsd: Number(attrs?.total_reserve_in_usd ?? 0),
    volume24hUsd: Number(attrs?.volume_usd?.h24 ?? 0),
    priceChange24hPct: Number(attrs?.price_change_percentage?.h24 ?? 0),
  };
}

// GeckoTerminal's multi-token endpoint accepts up to 30 addresses per call.
const MULTI_PRICE_CHUNK_SIZE = 30;

export async function getMultiPrice(addresses: string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (addresses.length === 0) return prices;

  for (let i = 0; i < addresses.length; i += MULTI_PRICE_CHUNK_SIZE) {
    const chunk = addresses.slice(i, i + MULTI_PRICE_CHUNK_SIZE);
    const body = await gtGet(`/networks/${NETWORK}/tokens/multi/${chunk.join(",")}`);
    const items = (body?.data ?? []) as any[];

    for (const item of items) {
      const address = item?.attributes?.address;
      const value = Number(item?.attributes?.price_usd ?? NaN);
      if (address && Number.isFinite(value) && value > 0) prices.set(address, value);
    }
  }

  return prices;
}

// Bounded page count, not derived from an assumed page size -- GeckoTerminal's
// actual /pools page size is itself an unverified guess, and the previous
// version broke out of the loop as soon as one page returned fewer results
// than that guess, which could stop discovery after a single page. Multiple
// distinct pools also frequently share the same base token (a blue-chip like
// SOL/USDC paired against several quote tokens across several DEXs all rank
// near the top by volume), so reaching `count` UNIQUE tokens can require
// scanning meaningfully more than `count` raw pools -- 20 pages is a bounded
// one-time cost per refresh (every refreshIntervalHours, or every
// FAILED_REFRESH_RETRY_MINUTES on failure -- not a per-poll-cycle cost).
const MAX_POOL_PAGES = 20;

/**
 * Top tokens by 24h volume, derived from the top pools listing (GeckoTerminal
 * has no direct "top tokens" endpoint) -- deduped by base-token address,
 * keeping each token's single highest-volume pool. Symbol/address are
 * resolved from the JSON:API `included` side-loaded token entities when
 * present, falling back to parsing the pool's "BASE / QUOTE" name field.
 */
export async function getTopTradedTokens(
  count: number,
  minLiquidityUsd: number,
  minTokenAgeHours: number,
  excludedSymbols: string[] = [],
): Promise<TopTradedToken[]> {
  const excludedSymbolSet = new Set(excludedSymbols.map((s) => s.toUpperCase()));
  const seen = new Map<string, TopTradedToken>();
  let poolsScanned = 0;
  let excludedForAge = 0;
  let excludedForSymbol = 0;
  let missingAgeField = 0;
  let page = 1;

  for (; page <= MAX_POOL_PAGES && seen.size < count; page++) {
    // Paced, not hammered -- unlike a single-token OHLCV/price fetch, this
    // loop can issue up to MAX_POOL_PAGES requests back to back with nothing
    // else pacing it. A burst like that can trip rate limiting even under an
    // allowance that would be fine spread out (this was very likely why
    // real runs were failing around page 5-6 consistently).
    if (page > 1) await sleep(1500);

    let body: any;
    try {
      body = await gtGet(`/networks/${NETWORK}/pools`, { sort: "h24_volume_usd_desc", page: String(page) });
    } catch (err) {
      // Free-tier pool listings are commonly capped around page 10 -- if a
      // later page 400s/404s for that reason (or any other), don't throw
      // away every token already found on earlier pages. Only propagate if
      // even the FIRST page failed, since then there's nothing to salvage.
      if (page === 1) throw err;
      console.error(`getTopTradedTokens: page ${page} failed, stopping with what was already found:`, err instanceof Error ? err.message : err);
      break;
    }

    const pools = (body?.data ?? []) as any[];
    if (pools.length === 0) break; // only stop early on a genuinely empty page, not a "small" one
    poolsScanned += pools.length;

    const includedTokens = new Map<string, any>(
      ((body?.included ?? []) as any[]).filter((i) => i?.type === "token").map((i) => [i.id, i]),
    );

    for (const pool of pools) {
      const liquidityUsd = Number(pool?.attributes?.reserve_in_usd ?? 0);
      if (liquidityUsd < minLiquidityUsd) continue;

      // pool_created_at is my best understanding of GeckoTerminal's
      // documented pool attribute for creation time -- unverified from this
      // sandbox like everything else in this file. Missing/unparseable is
      // treated as "too young to trust," not "assume it's fine" -- this is
      // a risk control, so the safe default on uncertain data is exclusion,
      // not inclusion. missingAgeField in the summary log below makes it
      // visible if this field turns out not to exist as expected.
      const createdAtRaw = pool?.attributes?.pool_created_at;
      const createdAtMs = createdAtRaw ? new Date(createdAtRaw).getTime() : NaN;
      if (!Number.isFinite(createdAtMs)) {
        missingAgeField++;
        continue;
      }
      const ageHours = (Date.now() - createdAtMs) / (1000 * 60 * 60);
      if (ageHours < minTokenAgeHours) {
        excludedForAge++;
        continue;
      }

      const baseTokenId: string | undefined = pool?.relationships?.base_token?.data?.id;
      if (!baseTokenId) continue;
      const address = stripNetworkPrefix(baseTokenId);
      if (seen.has(address)) continue;

      const includedToken = includedTokens.get(baseTokenId);
      const symbol: string | undefined =
        includedToken?.attributes?.symbol ?? String(pool?.attributes?.name ?? "").split("/")[0]?.trim();
      if (!symbol) continue;

      if (excludedSymbolSet.has(symbol.toUpperCase())) {
        excludedForSymbol++;
        continue;
      }

      seen.set(address, {
        symbol,
        address,
        liquidityUsd,
        volume24hUsd: Number(pool?.attributes?.volume_usd?.h24 ?? 0),
      });
    }
  }

  console.log(
    `getTopTradedTokens: found ${seen.size}/${count} unique tokens from ${poolsScanned} pools across ${page - 1} page(s)` +
      ` (excluded ${excludedForAge} under ${minTokenAgeHours}h old, ${excludedForSymbol} stablecoins/excluded symbols, ${missingAgeField} with no parseable pool_created_at)` +
      (seen.size < count ? " -- ran out of pages or pools before reaching the target count" : "") +
      (missingAgeField > poolsScanned / 2 ? " -- WARNING: pool_created_at may not be the right field name, check a raw response" : ""),
  );

  return [...seen.values()].slice(0, count);
}
