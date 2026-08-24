-- Wallet-tail research module -- fully separate paper-trading experiment
-- that mirrors a specific wallet's swaps to test whether copy-tailing is
-- viable. Deliberately isolated from the main strategy's trades/positions/
-- circuit_breaker_state tables: no foreign keys into them, no shared IDs,
-- never read by src/engine/loop.ts or anything under src/onchain/*. See
-- src/tail/README.md.
--
-- Lives in the same physical SQLite file as the main schema (src/db/schema.sql)
-- for operational simplicity (one file to back up, one connection pool), but
-- every table here is prefixed tail_ and touched only by code under src/tail/.

CREATE TABLE IF NOT EXISTS tail_wallets (
  address TEXT PRIMARY KEY,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per mirrored round trip -- opened by the tailed wallet's buy,
-- closed by its matching sell. status distinguishes a clean round trip from
-- the two ways this can go wrong: no price data to open the paper position
-- at all (unfillable_entry, no position ever opened), or a position that
-- opened fine but couldn't get a price when the wallet sold
-- (unfillable_exit -- left open, flagged for manual review, never silently
-- dropped or fabricated closed).
CREATE TABLE IF NOT EXISTS tail_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL REFERENCES tail_wallets (address),
  token_address TEXT NOT NULL,
  token_symbol TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'unfillable_entry', 'unfillable_exit')),

  usd_size REAL NOT NULL, -- TAIL_STARTING_BALANCE_USD x TAIL_POSITION_SIZE_PCT, snapshotted at entry (fixed, not compounding -- same convention as the main bot's paper sizing)
  quantity REAL, -- NULL when unfillable_entry -- no position was ever opened

  -- The tailed wallet's actual fill, reconstructed from the on-chain swap.
  wallet_entry_price_usd REAL NOT NULL,
  wallet_entry_tx_signature TEXT NOT NULL UNIQUE,
  wallet_entry_onchain_at TEXT NOT NULL,

  -- Detection + simulated pipeline latency for the entry.
  entry_detected_at TEXT NOT NULL, -- webhook receipt/parse time
  entry_detection_latency_ms REAL NOT NULL, -- entry_detected_at - wallet_entry_onchain_at

  -- This bot's simulated fill: price at (entry_detected_at + TAIL_SIMULATED_DELAY_SECONDS), not an instant/perfect fill.
  sim_entry_fill_at TEXT,
  sim_entry_fill_price_usd REAL, -- NULL when unfillable_entry
  entry_liquidity_usd REAL, -- pool depth at sim fill time -- NULL when unfillable
  entry_market_cap_usd REAL, -- market cap (or FDV fallback) at sim fill time, from the same provider call -- NULL when unavailable or unfillable
  entry_slippage_vs_wallet_pct REAL, -- (sim_entry_fill - wallet_entry) / wallet_entry x 100

  -- Same fields, mirrored for the close (the wallet's sell).
  wallet_exit_price_usd REAL,
  wallet_exit_tx_signature TEXT UNIQUE,
  wallet_exit_onchain_at TEXT,
  exit_detected_at TEXT,
  exit_detection_latency_ms REAL,
  sim_exit_fill_at TEXT,
  sim_exit_fill_price_usd REAL,
  exit_liquidity_usd REAL,
  exit_market_cap_usd REAL,
  exit_slippage_vs_wallet_pct REAL,

  -- The realistic simulated result -- the actual thing this module exists to measure.
  pnl_usd REAL,
  pnl_pct REAL,
  -- Same position/quantity, but filled at the wallet's exact price/time
  -- instead of the simulated (lagged) fill -- isolates how much of the
  -- result is pure lag cost vs. the trade itself being good or bad.
  wallet_exact_pnl_usd REAL,
  wallet_exact_pnl_pct REAL,

  -- 1 when this position was closed via the dashboard's manual Sell button
  -- (see dashboardRoutes.ts's POST /trades/:id/sell) instead of by detecting
  -- the tailed wallet's own sell -- e.g. as a substitute for scraping
  -- pump.fun "callouts" for an exit signal. wallet_exit_*/wallet_exact_pnl_*
  -- stay NULL on these rows: there was no wallet sell event to compare
  -- against, only pnl_usd/pnl_pct (this app's own simulated result) apply.
  closed_manually INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_tail_trades_wallet_status ON tail_trades (wallet_address, status);
CREATE INDEX IF NOT EXISTS idx_tail_trades_wallet_token_status ON tail_trades (wallet_address, token_address, status);
CREATE INDEX IF NOT EXISTS idx_tail_trades_created_at ON tail_trades (created_at);

-- Raw log of every webhook delivery, whether or not it produced a trade --
-- the audit trail coverage-gap detection (src/tail/webhook.ts) is built
-- from. Recording ignored/unparseable events, not just successful ones, is
-- what makes it possible to tell "the wallet was quiet" apart from
-- "something broke and we stopped seeing events."
CREATE TABLE IF NOT EXISTS tail_webhook_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  tx_signature TEXT,
  status TEXT NOT NULL CHECK (status IN ('parsed_buy', 'parsed_sell', 'ignored_non_swap', 'ignored_duplicate', 'ignored_already_open', 'ignored_no_open_position', 'parse_error', 'auth_rejected')),
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_tail_webhook_log_received_at ON tail_webhook_log (received_at);

-- Explicit record of any known interruption in coverage -- populated when
-- the webhook handler itself errors, or on module startup if there's a
-- suspiciously large gap since the last received event. This can only see
-- what happens on THIS side (server errors, restarts); it cannot detect a
-- delivery failure on the webhook provider's side that never reached this
-- server at all, and `detail` says so rather than implying full coverage
-- confidence.
CREATE TABLE IF NOT EXISTS tail_coverage_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT,
  gap_started_at TEXT, -- best-known start of the gap; NULL if unknown
  detected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reason TEXT NOT NULL, -- 'handler_error' | 'startup_gap'
  detail TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tail_coverage_gaps_detected_at ON tail_coverage_gaps (detected_at);
