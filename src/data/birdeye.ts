import { env } from "../config/env.js";

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

/** Retries with backoff on 429 -- the free tier's rate limit is easy to hit with multiple watchlist tokens in one poll cycle. */
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

export type OhlcvInterval = "1m" | "5m" | "15m" | "30m" | "1H" | "2H" | "4H" | "6H" | "8H" | "12H" | "1D";

export interface OhlcvCandle {
  unixTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Interval scales with the configured lookback so a token watched over a few
// hours gets fine-grained candles, while a multi-week lookback doesn't over-fetch.
export function pickOhlcvInterval(lookbackHours: number): OhlcvInterval {
  if (lookbackHours <= 12) return "5m";
  if (lookbackHours <= 48) return "15m";
  if (lookbackHours <= 24 * 14) return "1H";
  return "4H";
}

export async function getOhlcv(
  address: string,
  type: OhlcvInterval,
  timeFrom: number,
  timeTo: number,
): Promise<OhlcvCandle[]> {
  const data = await birdeyeGet("/defi/ohlcv", {
    address,
    type,
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

export interface TokenOverview {
  price: number;
  liquidityUsd: number;
  volume24hUsd: number;
  priceChange24hPct: number;
}

export async function getTokenOverview(address: string): Promise<TokenOverview> {
  const data = await birdeyeGet("/defi/token_overview", { address });

  return {
    price: Number(data?.price ?? 0),
    liquidityUsd: Number(data?.liquidity ?? 0),
    volume24hUsd: Number(data?.v24hUSD ?? data?.volume24h ?? 0),
    priceChange24hPct: Number(data?.priceChange24hPercent ?? 0),
  };
}
