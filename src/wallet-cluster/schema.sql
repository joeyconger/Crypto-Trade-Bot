-- Wallet clustering / side-wallet detection -- a standalone, manually-triggered
-- ANALYSIS tool. Correlation-based inference, never proof of identity or
-- ownership: every score here means "consistent with being a controlled
-- wallet," never "confirmed." No execution path exists in this module or
-- anywhere it touches -- it only reads chain data and writes analysis
-- results. Fully separate from the main strategy's and the wallet-tail
-- module's tables; namespaced wallet_cluster_*.

-- One row per pipeline run against a given main wallet, so repeated runs
-- over time are comparable (candidate sets/scores can shift as the main
-- wallet trades more tokens and more evidence accumulates).
CREATE TABLE IF NOT EXISTS wallet_cluster_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  main_wallet TEXT NOT NULL,
  run_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- Params used for this run -- kept alongside results since a different
  -- preBuyWindowMinutes/minOverlapCount genuinely changes what "consistent
  -- with" means, and a later run might use different values.
  pre_buy_window_minutes INTEGER NOT NULL,
  min_overlap_count INTEGER NOT NULL,

  tokens_analyzed_json TEXT NOT NULL, -- JSON array of {address, symbol, mainWalletBuyAt} actually used for this run
  token_count INTEGER NOT NULL,

  -- Explicit, honest sample-size flag -- set true when the input sample was
  -- too short or too clustered in time to produce a meaningful result, so a
  -- low/zero-candidate outcome isn't mistaken for "we checked thoroughly and
  -- found nothing."
  sample_too_thin INTEGER NOT NULL DEFAULT 0,
  sample_note TEXT, -- human-readable reason when sample_too_thin, or other caveats about this run's coverage

  candidates_found INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_wallet_cluster_runs_main_wallet ON wallet_cluster_runs (main_wallet, run_at);

-- One row per candidate wallet surfaced by a run, above min_overlap_count.
CREATE TABLE IF NOT EXISTS wallet_cluster_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES wallet_cluster_runs (id),
  candidate_wallet TEXT NOT NULL,

  overlap_count INTEGER NOT NULL, -- # of the input tokens this wallet appeared as a pre-buy-window early buyer on -- THE dominant ranking signal
  overlap_tokens_json TEXT NOT NULL, -- JSON array of {address, symbol, candidateBuyAt, mainWalletBuyAt, minutesBeforeMainBuy}

  funding_link_found INTEGER NOT NULL DEFAULT 0,
  funding_link_hop_distance INTEGER, -- 1 (direct transfer) or 2 (shared one-hop counterparty), NULL if none found
  funding_link_detail TEXT, -- e.g. the shared intermediary address for hop-distance 2

  -- Per-token sell-timing comparisons -- JSON array of
  -- {address, symbol, candidateHoldMinutes, mainWalletHoldMinutes, candidateSoldSooner}
  -- deliberately NOT collapsed into one number since hold times vary a lot
  -- token to token (see the module's README/comments).
  sell_timing_json TEXT,

  fee_payer_overlap_found INTEGER NOT NULL DEFAULT 0,
  fee_payer_overlap_detail TEXT,

  -- Explicit data-availability flags -- set false (with a reason in
  -- data_gaps_note) when a check couldn't be completed reliably, rather
  -- than silently treating "unknown" as "no."
  funding_link_checked INTEGER NOT NULL DEFAULT 1,
  sell_timing_checked INTEGER NOT NULL DEFAULT 1,
  fee_payer_checked INTEGER NOT NULL DEFAULT 1,
  data_gaps_note TEXT,

  confidence_score REAL NOT NULL, -- 0-100, see src/wallet-cluster/scoring.ts for the weighting and its documented rationale
  confidence_band TEXT NOT NULL, -- 'low' | 'moderate' | 'high' -- human-readable banding of confidence_score, never "confirmed"

  -- Manual review workflow for the exclusion-list suggestion -- see
  -- src/wallet-cluster/README or the module's dashboard section. NEVER
  -- auto-populated into config/watchlist.yaml's excludedSymbols-equivalent
  -- or any strategy config; a human approves each addition explicitly.
  suggested_for_exclusion INTEGER NOT NULL DEFAULT 0, -- true when this candidate cleared the (high overlap AND funding link) suggestion threshold
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
  reviewed_at TEXT,
  reviewed_note TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_wallet_cluster_candidates_run ON wallet_cluster_candidates (run_id, confidence_score);
CREATE INDEX IF NOT EXISTS idx_wallet_cluster_candidates_wallet ON wallet_cluster_candidates (candidate_wallet);
CREATE INDEX IF NOT EXISTS idx_wallet_cluster_candidates_review ON wallet_cluster_candidates (review_status);
