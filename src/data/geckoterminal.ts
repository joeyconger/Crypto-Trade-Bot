import { getCachedPoolAddress, setCachedPoolAddress } from "../db/index.js";
import type { OhlcvCandle, TokenOverview, TopTradedToken } from "./types.js";

/**
 * GeckoTerminal's free public API -- no API key/signup required, unlike
 * Birdeye. Used as the fallback price/OHLCV provider when Birdeye's quota is
 * exhausted (see PRICE_PROVIDER in config/env.ts). Field shapes below are my
 * best understanding of GeckoTerminal's documented v2 API and are UNVERIFIED
 * from this sandbox (no live network access) -- check the raw error message
 * on the first live run before assuming the strategy logic is at fault, same
 * caveat as every Birdeye endpoint in data/birdeye.ts.
 *
 * Free-tier rate limit is commonly cited around 30 requests/minute --
 * noticeably tighter than Birdeye's. TOKEN_STAGGER_MS in engine/loop.ts and
 * the retry-with-backoff below are both tuned with that in mind, but a large
 * due-token burst (e.g. ~100 tokens becoming due at once every
 * technicalRefreshIntervalMinutes) will still run slower than it did on
 * Birdeye -- that's an accepted tradeoff for staying on a free, unmetered
 * plan while Birdeye's quota resets.
 */

const BASE_URL = "https://api.geckoterminal.com/api/v2";
const NETWORK = "solana";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gtGet(path: string, params: Record<string, string> = {}, retries = 3): Promise<any> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json" } });

    if (res.status === 429 && attempt < retries) {
      await sleep(1500 * (attempt + 1));
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

const POOLS_PAGE_SIZE = 20; // GeckoTerminal's /pools listing page size

/**
 * Top tokens by 24h volume, derived from the top pools listing (GeckoTerminal
 * has no direct "top tokens" endpoint) -- deduped by base-token address,
 * keeping each token's single highest-volume pool. Symbol/address are
 * resolved from the JSON:API `included` side-loaded token entities when
 * present, falling back to parsing the pool's "BASE / QUOTE" name field.
 */
export async function getTopTradedTokens(count: number, minLiquidityUsd: number): Promise<TopTradedToken[]> {
  const seen = new Map<string, TopTradedToken>();
  const maxPages = Math.ceil(count / POOLS_PAGE_SIZE) + 2; // a little slack for dedup/liquidity filtering

  for (let page = 1; page <= maxPages && seen.size < count; page++) {
    const body = await gtGet(`/networks/${NETWORK}/pools`, {
      sort: "h24_volume_usd_desc",
      page: String(page),
    });

    const pools = (body?.data ?? []) as any[];
    if (pools.length === 0) break;

    const includedTokens = new Map<string, any>(
      ((body?.included ?? []) as any[]).filter((i) => i?.type === "token").map((i) => [i.id, i]),
    );

    for (const pool of pools) {
      const liquidityUsd = Number(pool?.attributes?.reserve_in_usd ?? 0);
      if (liquidityUsd < minLiquidityUsd) continue;

      const baseTokenId: string | undefined = pool?.relationships?.base_token?.data?.id;
      if (!baseTokenId) continue;
      const address = stripNetworkPrefix(baseTokenId);
      if (seen.has(address)) continue;

      const includedToken = includedTokens.get(baseTokenId);
      const symbol: string | undefined =
        includedToken?.attributes?.symbol ?? String(pool?.attributes?.name ?? "").split("/")[0]?.trim();
      if (!symbol) continue;

      seen.set(address, {
        symbol,
        address,
        liquidityUsd,
        volume24hUsd: Number(pool?.attributes?.volume_usd?.h24 ?? 0),
      });
    }

    if (pools.length < POOLS_PAGE_SIZE) break;
  }

  return [...seen.values()].slice(0, count);
}
