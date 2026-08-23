// Provider-agnostic shapes -- both src/data/birdeye.ts and
// src/data/geckoterminal.ts return these, so every caller (signals,
// execution, dashboard) is written against this file, not a specific
// provider's response format. See src/data/priceProvider.ts for how the
// active provider is selected.

export interface OhlcvCandle {
  unixTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TokenOverview {
  price: number;
  liquidityUsd: number;
  volume24hUsd: number;
  priceChange24hPct: number;
  // Optional -- both providers' token-overview responses include this
  // alongside the fields above, so it costs nothing extra to read, but
  // callers that only care about price/liquidity (most of them) can ignore
  // it. Undefined if the provider's response didn't have a usable symbol.
  symbol?: string;
  // Market cap in USD, when the provider has one to report. Many meme/
  // pump.fun-style tokens don't have a distinct "circulating supply" concept
  // (effectively all supply is circulating from launch), so this falls back
  // to fully-diluted valuation (FDV) when a provider only has that --
  // undefined if neither is available.
  marketCapUsd?: number;
}

export interface TopTradedToken {
  symbol: string;
  address: string;
  liquidityUsd: number;
  volume24hUsd: number;
}
