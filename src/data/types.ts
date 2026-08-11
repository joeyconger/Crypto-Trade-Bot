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
}

export interface TopTradedToken {
  symbol: string;
  address: string;
  liquidityUsd: number;
  volume24hUsd: number;
}
