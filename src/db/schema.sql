-- Mirrors config/watchlist.yaml so trades/signal_log can foreign-key against
-- a stable token registry. The YAML file remains the source of truth for
-- strategy params; this table is resynced from it on every startup.
CREATE TABLE IF NOT EXISTS watchlist_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,
  -- Cursor for whale-move polling (src/onchain/whales.ts): the most recent
  -- Helius tx signature already scored, so each poll only looks at new ones.
  last_tx_signature TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Our own history of Birdeye liquidity/volume snapshots, since the free tier
-- doesn't expose historical liquidity -- we build the rolling average ourselves
-- from what we've observed across poll cycles.
CREATE TABLE IF NOT EXISTS onchain_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  liquidity_usd REAL NOT NULL,
  volume_24h_usd REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_onchain_snapshots_token ON onchain_snapshots (token_address, captured_at);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL REFERENCES watchlist_tokens (address),
  token_symbol TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),

  entry_price REAL NOT NULL,
  exit_price REAL,
  quantity REAL NOT NULL,
  usd_size REAL NOT NULL,

  stop_loss_price REAL,
  take_profit_price REAL,

  reason TEXT, -- human-readable summary of which signals fired
  tx_signature TEXT, -- set only for mode = 'live'

  pnl_usd REAL,
  pnl_pct REAL,

  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_trades_token ON trades (token_address);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades (status);
CREATE INDEX IF NOT EXISTS idx_trades_opened_at ON trades (opened_at);

-- One row per signal evaluation per token, whether or not it triggered a
-- trade -- this is the "why did/didn't the bot act" audit trail.
CREATE TABLE IF NOT EXISTS signal_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  token_symbol TEXT NOT NULL,
  evaluated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  technical_score REAL,
  onchain_score REAL,
  social_score REAL,
  combined_score REAL,

  technical_detail TEXT, -- JSON blob: fib levels checked, swing high/low, confluence, etc.
  onchain_detail TEXT, -- JSON blob: whale txs seen, volume/liquidity vs rolling avg
  social_detail TEXT, -- JSON blob: matched tweets + keyword scores

  action_taken TEXT NOT NULL DEFAULT 'none' CHECK (action_taken IN ('none', 'buy', 'sell')),
  trade_id INTEGER REFERENCES trades (id)
);

CREATE INDEX IF NOT EXISTS idx_signal_log_token ON signal_log (token_address);
CREATE INDEX IF NOT EXISTS idx_signal_log_evaluated_at ON signal_log (evaluated_at);
