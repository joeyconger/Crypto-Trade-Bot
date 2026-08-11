-- Mirrors config/watchlist.yaml so trades/wallet tables can foreign-key
-- against a stable token registry. The YAML file remains the source of
-- truth for strategy params; this table is resynced from it on startup.
CREATE TABLE IF NOT EXISTS watchlist_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,
  -- Cursor for wallet-activity polling (src/onchain/walletActivity.ts): the
  -- most recent Helius tx signature already recorded, so each poll only
  -- looks at new ones.
  last_tx_signature TEXT,
  -- Last time this token's technical trigger (OHLCV fetch + fib/RSI/volume/
  -- close checks) was evaluated while it had no open position. NULL means
  -- never -- immediately due. Not touched while a position is open (those
  -- are managed every cycle regardless); see engine/loop.ts.
  last_technical_eval_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- GeckoTerminal's OHLCV endpoint is scoped to a liquidity pool, not a token
-- mint -- caches each token's resolved primary pool (data/geckoterminal.ts)
-- so that lookup only costs a network call the first time a token is seen,
-- not on every OHLCV fetch. Unused when PRICE_PROVIDER=birdeye.
CREATE TABLE IF NOT EXISTS token_pool_cache (
  token_address TEXT PRIMARY KEY,
  pool_address TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Every observed buy/sell on a watchlist token, for any wallet size -- not
-- just qualifying "whale" candidates. This is the raw material wallet
-- reputation and entry-trigger confirmation are built from.
CREATE TABLE IF NOT EXISTS wallet_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  usd_size REAL NOT NULL,
  tx_signature TEXT NOT NULL UNIQUE,
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_wallet_activity_wallet ON wallet_activity (wallet_address, observed_at);
CREATE INDEX IF NOT EXISTS idx_wallet_activity_token ON wallet_activity (token_address, observed_at);

-- Cached per-wallet reputation state. age/tag are looked up from Helius once
-- and cached (age_checked_at) rather than refetched every cycle; reputation_score
-- starts neutral (0) and updates as the bot observes more of that wallet's
-- outcomes over time, per src/onchain/walletReputation.ts.
CREATE TABLE IF NOT EXISTS wallet_reputation (
  wallet_address TEXT PRIMARY KEY,
  tag TEXT, -- 'exchange' | 'bridge' | 'market_maker' | NULL (unknown/regular wallet)
  first_tx_at TEXT, -- oldest tx timestamp found via bounded Helius history lookup (age proxy)
  history_tx_count INTEGER NOT NULL DEFAULT 0, -- tx count found in that same bounded lookup ("prior trade history")
  age_checked_at TEXT,
  reputation_score REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL REFERENCES watchlist_tokens (address),
  token_symbol TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),

  entry_price REAL NOT NULL,
  quantity REAL NOT NULL, -- original full size, in tokens
  quantity_remaining REAL NOT NULL, -- decreases as tranches scale out
  usd_size REAL NOT NULL, -- original full USD size

  -- Fib/ATR context captured at entry -- needed afterward to compute
  -- extension targets and the structure-based trailing stop.
  swing_high REAL NOT NULL,
  swing_low REAL NOT NULL,
  fib_zone_level REAL NOT NULL, -- 0.5 or 0.618 -- which golden-pocket level triggered entry
  atr_at_entry REAL NOT NULL,
  extension_1272_price REAL NOT NULL,
  extension_1618_price REAL NOT NULL,

  stop_price REAL NOT NULL, -- current active stop; moves to breakeven then trails once the runner is active
  scale_out_1_done INTEGER NOT NULL DEFAULT 0,
  scale_out_2_done INTEGER NOT NULL DEFAULT 0,
  runner_active INTEGER NOT NULL DEFAULT 0, -- true once scale_out_2 fires and the final third is trailing
  time_exit_deadline TEXT NOT NULL, -- opened_at + configured hours; irrelevant once scale_out_1_done

  reason TEXT, -- human-readable summary of what fired the entry
  tx_signature TEXT, -- entry swap signature, live mode only

  exit_price REAL, -- quantity-weighted avg exit price across all tranches, set once fully closed
  pnl_usd REAL,
  pnl_pct REAL,

  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_trades_token ON trades (token_address);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades (status);
CREATE INDEX IF NOT EXISTS idx_trades_opened_at ON trades (opened_at);

-- Each partial exit (the two 33% scale-outs, and the runner's final close)
-- against a trade. The parent trades row aggregates these once fully closed.
CREATE TABLE IF NOT EXISTS position_exits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER NOT NULL REFERENCES trades (id),
  tranche TEXT NOT NULL CHECK (tranche IN ('scale_1', 'scale_2', 'runner')),
  quantity REAL NOT NULL,
  exit_price REAL NOT NULL,
  exit_reason TEXT NOT NULL, -- 'extension_1272' | 'extension_1618' | 'stop_loss' | 'trailing_stop' | 'time_exit' | 'signal_reversal'
  pnl_usd REAL NOT NULL,
  tx_signature TEXT,
  exited_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_position_exits_trade ON position_exits (trade_id);

-- The wallets whose confirmed buys fired a trade's entry signal, with their
-- reputation at the time -- the "wallets that fired the signal + their
-- quality scores" logging requirement.
CREATE TABLE IF NOT EXISTS trade_signal_wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER NOT NULL REFERENCES trades (id),
  wallet_address TEXT NOT NULL,
  usd_size REAL NOT NULL,
  reputation_score REAL NOT NULL,
  wallet_age_days REAL,
  tx_signature TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trade_signal_wallets_trade ON trade_signal_wallets (trade_id);

-- One row per entry-trigger evaluation per token, whether or not it led to a
-- trade -- the "why did/didn't the bot act" audit trail.
CREATE TABLE IF NOT EXISTS signal_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  token_symbol TEXT NOT NULL,
  evaluated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- Technical trigger (trend + fib/structural confluence + RSI + volume +
  -- close confirmation) is the entry gate. On-chain wallet confirmation is
  -- optional confluence, evaluated independently and never blocking.
  technical_trigger_passed INTEGER NOT NULL DEFAULT 0,
  onchain_confluence_present INTEGER NOT NULL DEFAULT 0,
  action_taken TEXT NOT NULL DEFAULT 'none' CHECK (action_taken IN ('none', 'buy', 'sell')),
  detail TEXT, -- JSON: which technical conditions passed/failed, confirming wallets if any, skip reason

  trade_id INTEGER REFERENCES trades (id)
);

CREATE INDEX IF NOT EXISTS idx_signal_log_token ON signal_log (token_address);
CREATE INDEX IF NOT EXISTS idx_signal_log_evaluated_at ON signal_log (evaluated_at);

-- Single-row runtime state. Dashboard-controlled pause is separate from the
-- LIVE_TRADING env gate: pausing halts the poll loop from acting without
-- touching the paper/live safety gate, which stays env-only by design.
CREATE TABLE IF NOT EXISTS bot_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 0,
  -- Last time the dynamic (top_traded) watchlist was re-selected from
  -- Birdeye. NULL means never -- the first poll cycle always refreshes.
  watchlist_last_refreshed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO bot_state (id, paused) VALUES (1, 0);

-- Account-level circuit breakers (src/execution/circuitBreakers.ts). The
-- daily halt needs no persisted state -- it's computed live from today's
-- realized P&L each cycle, so it auto-clears the next UTC day for free.
-- Weekly and consecutive-loss halts are sticky by design ("no auto-resume")
-- and stay halted until a human resumes them via the dashboard.
CREATE TABLE IF NOT EXISTS circuit_breaker_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  weekly_halted INTEGER NOT NULL DEFAULT 0,
  consecutive_losses INTEGER NOT NULL DEFAULT 0,
  consecutive_loss_halted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO circuit_breaker_state (id) VALUES (1);
