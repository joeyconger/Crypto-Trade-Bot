import { env } from "../config/env.js";
import type { OhlcvCandle, TokenOverview, TopTradedToken } from "./types.js";

const BASE_URL = "https://public-api.birdeye.so";

function headers(): Record<string, string> {
  if (!env.BIRDEYE_API_KEY) throw new Error("BIRDEYE_API_KEY is not set");
  return {
    "X-API-KEY": env.BIRDEYE_API_KEY,
    "x-chain": "solana",
    accept: "application/json",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries with backoff on 429 -- the free tier's rate limit is easy to hit under bursty lookup patterns. */
async function birdeyeGet(path: string, params: Record<string, string>, retries = 2): Promise<any> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { headers: headers() });

    if (res.status === 429 && attempt < retries) {
      await sleep(1000 * (attempt + 1));
      continue;
    }

    const body: any = await res.json().catch(() => undefined);
    if (!res.ok || !body?.success) {
      throw new Error(`Birdeye request to ${path} failed (${res.status}): ${JSON.stringify(body)}`);
    }
    return body.data;
  }

  throw new Error(`Birdeye request to ${path} failed after ${retries} retries (rate limited)`);
}

type OhlcvInterval = "1m" | "5m" | "15m" | "30m" | "1H" | "2H" | "4H" | "6H" | "8H" | "12H" | "1D";

// Interval scales with the configured lookback so a token watched over a few
// hours gets fine-grained candles, while a multi-week lookback doesn't over-fetch.
function pickOhlcvInterval(lookbackHours: number): OhlcvInterval {
  if (lookbackHours <= 12) return "5m";
  if (lookbackHours <= 48) return "15m";
  if (lookbackHours <= 24 * 14) return "1H";
  return "4H";
}

export async function getOhlcv(
  address: string,
  swingLookbackHours: number,
  timeFrom: number,
  timeTo: number,
): Promise<OhlcvCandle[]> {
  const data = await birdeyeGet("/defi/ohlcv", {
    address,
    type: pickOhlcvInterval(swingLookbackHours),
    time_from: String(timeFrom),
    time_to: String(timeTo),
  });

  const items = data?.items ?? [];
  return items.map((item: any) => ({
    unixTime: item.unixTime,
    open: item.o,
    high: item.h,
    low: item.l,
    close: item.c,
    volume: item.v,
  }));
}

export async function getTokenOverview(address: string): Promise<TokenOverview> {
  const data = await birdeyeGet("/defi/token_overview", { address });

  // Best-understanding Birdeye field names for market cap, unverified from
  // this sandbox like the rest of this file -- `mc` per Birdeye's documented
  // /defi/token_overview response, falling back to fully-diluted valuation
  // if that's zero/missing (same reasoning as geckoterminal.ts).
  const marketCapRaw = Number(data?.mc ?? 0);
  const fdvRaw = Number(data?.fdv ?? data?.realMc ?? 0);
  const marketCapUsd = marketCapRaw > 0 ? marketCapRaw : fdvRaw > 0 ? fdvRaw : undefined;

  return {
    price: Number(data?.price ?? 0),
    liquidityUsd: Number(data?.liquidity ?? 0),
    volume24hUsd: Number(data?.v24hUSD ?? data?.volume24h ?? 0),
    priceChange24hPct: Number(data?.priceChange24hPercent ?? 0),
    symbol: typeof data?.symbol === "string" && data.symbol.length > 0 ? data.symbol : undefined,
    marketCapUsd,
  };
}

// Birdeye's multi_price endpoint accepts a comma-separated address list --
// chunked the same way as tokenlist pagination, at a conservative page size.
const MULTI_PRICE_CHUNK_SIZE = 100;

/**
 * Batched current-price lookup for many tokens in one or a few Birdeye calls,
 * replacing a per-token /defi/token_overview call just to get price. Field
 * shape (`data[address].value`) is my best understanding of Birdeye's
 * documented /defi/multi_price response and, like getTopTradedTokens, is
 * unverified from this sandbox (no live network access) -- check the raw
 * response on the first live run if this comes back empty. Addresses with no
 * price in the response (delisted, no liquidity, etc.) are simply absent from
 * the returned map -- callers should fall back to getTokenOverview for those.
 */
export async function getMultiPrice(addresses: string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (addresses.length === 0) return prices;

  for (let i = 0; i < addresses.length; i += MULTI_PRICE_CHUNK_SIZE) {
    const chunk = addresses.slice(i, i + MULTI_PRICE_CHUNK_SIZE);
    const data = await birdeyeGet("/defi/multi_price", { list_address: chunk.join(",") });

    for (const address of chunk) {
      const value = Number(data?.[address]?.value ?? NaN);
      if (Number.isFinite(value) && value > 0) prices.set(address, value);
    }
  }

  return prices;
}

// Birdeye's tokenlist page size caps at 50 -- fetch in pages to cover larger counts.
const TOKENLIST_PAGE_SIZE = 50;

/**
 * Top tokens by 24h volume ("most traded"). Field names here are my best
 * understanding of Birdeye's documented /defi/tokenlist shape -- I have no
 * way to verify them from this environment (no live network access), and
 * this specific endpoint may also be gated to a paid tier even where
 * /defi/token_overview and /defi/ohlcv are available on Standard. Verify on
 * the first live run: if this throws or returns something empty, check the
 * raw error message it includes before assuming the strategy logic is at fault.
 */
/**
 * minTokenAgeHours is accepted for interface parity with the GeckoTerminal
 * provider (data/geckoterminal.ts) but NOT enforced here -- Birdeye's
 * /defi/tokenlist response shape (as documented/guessed above) doesn't
 * appear to expose a pool/token creation timestamp to filter on. If you're
 * running on PRICE_PROVIDER=birdeye and need the min-token-age control to
 * actually work, either confirm Birdeye exposes creation time somewhere in
 * this endpoint's real response and wire it in, or switch to
 * PRICE_PROVIDER=geckoterminal where it is enforced. excludedSymbols IS
 * enforced here (this endpoint's items already carry a symbol field).
 */
export async function getTopTradedTokens(
  count: number,
  minLiquidityUsd: number,
  minTokenAgeHours: number,
  excludedSymbols: string[] = [],
): Promise<TopTradedToken[]> {
  void minTokenAgeHours;
  const excludedSymbolSet = new Set(excludedSymbols.map((s) => s.toUpperCase()));
  const results: TopTradedToken[] = [];

  for (let offset = 0; offset < count; offset += TOKENLIST_PAGE_SIZE) {
    const data = await birdeyeGet("/defi/tokenlist", {
      sort_by: "v24hUSD",
      sort_type: "desc",
      offset: String(offset),
      limit: String(Math.min(TOKENLIST_PAGE_SIZE, count - offset)),
    });

    const items = data?.tokens ?? [];
    if (items.length === 0) break;

    for (const item of items) {
      const liquidityUsd = Number(item?.liquidity ?? 0);
      if (liquidityUsd < minLiquidityUsd) continue;
      if (!item?.address || !item?.symbol) continue;
      if (excludedSymbolSet.has(String(item.symbol).toUpperCase())) continue;

      results.push({
        symbol: item.symbol,
        address: item.address,
        liquidityUsd,
        volume24hUsd: Number(item?.v24hUSD ?? 0),
      });
    }

    if (items.length < TOKENLIST_PAGE_SIZE) break;
  }

  return results.slice(0, count);
}
