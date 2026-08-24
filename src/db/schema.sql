-- GeckoTerminal's OHLCV endpoint is scoped to a liquidity pool, not a token
-- mint -- caches each token's resolved primary pool (data/geckoterminal.ts)
-- so that lookup only costs a network call the first time a token is seen,
-- not on every OHLCV fetch. Unused when PRICE_PROVIDER=birdeye. Shared by
-- src/tail/* (and anything else using data/priceProvider.ts) -- not scoped
-- to any one subsystem.
CREATE TABLE IF NOT EXISTS token_pool_cache (
  token_address TEXT PRIMARY KEY,
  pool_address TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
