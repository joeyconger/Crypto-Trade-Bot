import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let initialized = false;

// CREATE TABLE IF NOT EXISTS (schema.sql) only handles a brand-new database
// -- it's a no-op against a table that already exists on a persisted volume,
// so a new column added here needs its own migration or it silently never
// appears on an existing deploy. SQLite has no "ADD COLUMN IF NOT EXISTS,"
// so this just attempts each addition and swallows the "duplicate column"
// error when it's already there. Add new tail_trades columns to this list
// alongside schema.sql, not instead of it (schema.sql is still what a fresh
// database gets on first run).
const TAIL_TRADES_MIGRATIONS: string[] = [
  "ALTER TABLE tail_trades ADD COLUMN entry_market_cap_usd REAL",
  "ALTER TABLE tail_trades ADD COLUMN exit_market_cap_usd REAL",
  "ALTER TABLE tail_trades ADD COLUMN closed_manually INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tail_trades ADD COLUMN is_live INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tail_trades ADD COLUMN own_entry_tx_signature TEXT",
  "ALTER TABLE tail_trades ADD COLUMN own_exit_tx_signature TEXT",
];

/** Applies tail_*'s own schema against the shared DB connection. Idempotent (CREATE TABLE IF NOT EXISTS + best-effort column migrations), safe to call on every startup. */
export function initTailSchema(): void {
  if (initialized) return;
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const db = getDb();
  db.exec(schema);
  for (const migration of TAIL_TRADES_MIGRATIONS) {
    try {
      db.exec(migration);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("duplicate column")) throw err;
    }
  }
  initialized = true;
}

export interface TailWalletRow {
  address: string;
  label: string | null;
  enabled: 0 | 1;
  created_at: string;
}

/**
 * Adds a wallet, or re-enables + relabels one that already exists (covers
 * both the startup env-seed path and the dashboard's "add wallet" action --
 * re-adding a previously-removed address should turn tailing back on for
 * it, not silently no-op because the row was already there).
 */
export function upsertTailWallet(address: string, label: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO tail_wallets (address, label, enabled) VALUES (?, ?, 1)
       ON CONFLICT(address) DO UPDATE SET label = excluded.label, enabled = 1`,
    )
    .run(address, label);
}

/**
 * Soft-disable rather than delete -- tail_trades.wallet_address has a
 * foreign key into this table, and a removed wallet's trade history should
 * stay visible in the dashboard's per-wallet breakdown, just no longer
 * actively watched. Note: any position still `open` for this wallet will
 * never get a matching sell webhook once it's also dropped from the Helius
 * watch list, so it stays open indefinitely -- the dashboard should warn
 * about this before removal, not just silently strand it.
 */
export function setTailWalletEnabled(address: string, enabled: boolean): void {
  getDb().prepare(`UPDATE tail_wallets SET enabled = ? WHERE address = ?`).run(enabled ? 1 : 0, address);
}

/** All tailed wallets ever configured, enabled or not -- the source of truth for the dashboard's per-wallet breakdown and management UI. */
export function getTailWallets(): TailWalletRow[] {
  return getDb().prepare(`SELECT * FROM tail_wallets ORDER BY created_at ASC`).all() as TailWalletRow[];
}

/** Just the addresses currently being watched -- what webhook.ts's per-tx loop iterates. */
export function getActiveTailWalletAddresses(): string[] {
  return (getDb().prepare(`SELECT address FROM tail_wallets WHERE enabled = 1`).all() as { address: string }[]).map(
    (r) => r.address,
  );
}

// ---- tail_trades ----

export interface TailTradeRow {
  id: number;
  wallet_address: string;
  token_address: string;
  token_symbol: string;
  status: "open" | "closed" | "unfillable_entry" | "unfillable_exit";
  usd_size: number;
  quantity: number | null;
  wallet_entry_price_usd: number;
  wallet_entry_tx_signature: string;
  wallet_entry_onchain_at: string;
  entry_detected_at: string;
  entry_detection_latency_ms: number;
  sim_entry_fill_at: string | null;
  sim_entry_fill_price_usd: number | null;
  entry_liquidity_usd: number | null;
  entry_market_cap_usd: number | null;
  entry_slippage_vs_wallet_pct: number | null;
  wallet_exit_price_usd: number | null;
  wallet_exit_tx_signature: string | null;
  wallet_exit_onchain_at: string | null;
  exit_detected_at: string | null;
  exit_detection_latency_ms: number | null;
  sim_exit_fill_at: string | null;
  sim_exit_fill_price_usd: number | null;
  exit_liquidity_usd: number | null;
  exit_market_cap_usd: number | null;
  exit_slippage_vs_wallet_pct: number | null;
  pnl_usd: number | null;
  pnl_pct: number | null;
  wallet_exact_pnl_usd: number | null;
  wallet_exact_pnl_pct: number | null;
  closed_manually: 0 | 1;
  is_live: 0 | 1;
  own_entry_tx_signature: string | null;
  own_exit_tx_signature: string | null;
  created_at: string;
  updated_at: string;
}

export interface OpenTailEntryInput {
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  usdSize: number;
  walletEntryPriceUsd: number;
  walletEntryTxSignature: string;
  walletEntryOnchainAt: string;
  entryDetectedAt: string;
  entryDetectionLatencyMs: number;
  isLive?: boolean;
}

/** Inserts the row immediately on detection, before the delayed sim fill (paper) or the swap result (live) is known -- status/quantity/fill fields are filled in by recordEntryFill once that resolves. */
export function insertPendingTailEntry(input: OpenTailEntryInput): number {
  const result = getDb()
    .prepare(
      `INSERT INTO tail_trades (
        wallet_address, token_address, token_symbol, status, usd_size,
        wallet_entry_price_usd, wallet_entry_tx_signature, wallet_entry_onchain_at,
        entry_detected_at, entry_detection_latency_ms, is_live
      ) VALUES (
        @walletAddress, @tokenAddress, @tokenSymbol, 'open', @usdSize,
        @walletEntryPriceUsd, @walletEntryTxSignature, @walletEntryOnchainAt,
        @entryDetectedAt, @entryDetectionLatencyMs, @isLive
      )`,
    )
    .run({ ...input, isLive: input.isLive ? 1 : 0 });
  return Number(result.lastInsertRowid);
}

export interface EntryFillResult {
  tradeId: number;
  simEntryFillAt: string;
  simEntryFillPriceUsd: number; // the fill price -- real (live) or simulated (paper); same column either way, see is_live
  entryLiquidityUsd: number | undefined; // undefined for a live fill whose best-effort liquidity lookup failed -- the swap itself already succeeded, this is just display context
  entryMarketCapUsd: number | undefined;
  quantity: number;
  ownEntryTxSignature?: string; // live only -- this bot's own buy tx signature
}

export function recordEntryFill(input: EntryFillResult): void {
  const trade = getTailTradeById(input.tradeId)!;
  const entrySlippageVsWalletPct =
    ((input.simEntryFillPriceUsd - trade.wallet_entry_price_usd) / trade.wallet_entry_price_usd) * 100;

  getDb()
    .prepare(
      `UPDATE tail_trades SET
        status = 'open', quantity = @quantity,
        sim_entry_fill_at = @simEntryFillAt, sim_entry_fill_price_usd = @simEntryFillPriceUsd,
        entry_liquidity_usd = @entryLiquidityUsd, entry_market_cap_usd = @entryMarketCapUsd,
        entry_slippage_vs_wallet_pct = @entrySlippageVsWalletPct,
        own_entry_tx_signature = COALESCE(@ownEntryTxSignature, own_entry_tx_signature),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = @tradeId`,
    )
    .run({
      ...input,
      entryLiquidityUsd: input.entryLiquidityUsd ?? null,
      entryMarketCapUsd: input.entryMarketCapUsd ?? null,
      entrySlippageVsWalletPct,
      ownEntryTxSignature: input.ownEntryTxSignature ?? null,
    });
}

export function markEntryUnfillable(tradeId: number): void {
  getDb()
    .prepare(
      `UPDATE tail_trades SET status = 'unfillable_entry', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    )
    .run(tradeId);
}

export function getOpenTailTrade(walletAddress: string, tokenAddress: string): TailTradeRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM tail_trades WHERE wallet_address = ? AND token_address = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(walletAddress, tokenAddress) as TailTradeRow | undefined;
}

export function getTailTradeById(id: number): TailTradeRow | undefined {
  return getDb().prepare(`SELECT * FROM tail_trades WHERE id = ?`).get(id) as TailTradeRow | undefined;
}

export interface RecordExitDetectionInput {
  tradeId: number;
  walletExitPriceUsd: number;
  walletExitTxSignature: string;
  walletExitOnchainAt: string;
  exitDetectedAt: string;
  exitDetectionLatencyMs: number;
}

/** Stamps the exit's on-chain/detection fields immediately -- sim fill fields come later via recordExitFill or markExitUnfillable. */
export function recordExitDetection(input: RecordExitDetectionInput): void {
  getDb()
    .prepare(
      `UPDATE tail_trades SET
        wallet_exit_price_usd = @walletExitPriceUsd, wallet_exit_tx_signature = @walletExitTxSignature,
        wallet_exit_onchain_at = @walletExitOnchainAt, exit_detected_at = @exitDetectedAt,
        exit_detection_latency_ms = @exitDetectionLatencyMs, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = @tradeId`,
    )
    .run(input);
}

export interface ExitFillResult {
  tradeId: number;
  simExitFillAt: string;
  simExitFillPriceUsd: number; // the fill price -- real (live) or simulated (paper); same column either way
  exitLiquidityUsd: number | undefined; // undefined for a live fill whose best-effort liquidity lookup failed
  exitMarketCapUsd: number | undefined;
  ownExitTxSignature?: string; // live only -- this bot's own sell tx signature
}

/** Closes the trade fully: computes both the realistic simulated P&L and the "if filled at the wallet's exact price/time" comparison P&L, from the same quantity basis. */
export function recordExitFill(input: ExitFillResult): void {
  const trade = getTailTradeById(input.tradeId)!;
  const quantity = trade.quantity!;
  const exitSlippageVsWalletPct = ((input.simExitFillPriceUsd - trade.wallet_exit_price_usd!) / trade.wallet_exit_price_usd!) * 100;

  const pnlUsd = (input.simExitFillPriceUsd - trade.sim_entry_fill_price_usd!) * quantity;
  const pnlPct = (pnlUsd / trade.usd_size) * 100;

  const walletExactPnlUsd = (trade.wallet_exit_price_usd! - trade.wallet_entry_price_usd) * quantity;
  const walletExactPnlPct = (walletExactPnlUsd / trade.usd_size) * 100;

  getDb()
    .prepare(
      `UPDATE tail_trades SET
        status = 'closed',
        sim_exit_fill_at = @simExitFillAt, sim_exit_fill_price_usd = @simExitFillPriceUsd,
        exit_liquidity_usd = @exitLiquidityUsd, exit_market_cap_usd = @exitMarketCapUsd,
        exit_slippage_vs_wallet_pct = @exitSlippageVsWalletPct,
        pnl_usd = @pnlUsd, pnl_pct = @pnlPct,
        wallet_exact_pnl_usd = @walletExactPnlUsd, wallet_exact_pnl_pct = @walletExactPnlPct,
        own_exit_tx_signature = COALESCE(@ownExitTxSignature, own_exit_tx_signature),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = @tradeId`,
    )
    .run({
      ...input,
      exitLiquidityUsd: input.exitLiquidityUsd ?? null,
      exitMarketCapUsd: input.exitMarketCapUsd ?? null,
      exitSlippageVsWalletPct,
      ownExitTxSignature: input.ownExitTxSignature ?? null,
      pnlUsd,
      pnlPct,
      walletExactPnlUsd,
      walletExactPnlPct,
    });
}

export interface ManualCloseResult {
  tradeId: number;
  exitPriceUsd: number;
  exitLiquidityUsd: number | null;
  exitMarketCapUsd: number | null;
  ownExitTxSignature?: string; // live only -- this bot's own sell tx signature
}

/**
 * Closes an open position from the dashboard's manual Sell button -- for a
 * paper trade, at a fresh price lookup; for a live trade (trade.is_live), at
 * the real fill price from an actual swap (see src/tail/liveExecution.ts).
 * Either way there's no wallet sell event backing this: only pnl_usd /
 * pnl_pct (this app's own result) get computed; the wallet_exit_ and
 * wallet_exact_pnl_ columns are left NULL since there's nothing to compare
 * against. closed_manually = 1 marks the row so the dashboard and any P&L
 * analysis can tell these apart from wallet-mirrored exits.
 */
export function closeTailTradeManually(input: ManualCloseResult): void {
  const trade = getTailTradeById(input.tradeId)!;
  const quantity = trade.quantity!;
  const pnlUsd = (input.exitPriceUsd - trade.sim_entry_fill_price_usd!) * quantity;
  const pnlPct = (pnlUsd / trade.usd_size) * 100;

  getDb()
    .prepare(
      `UPDATE tail_trades SET
        status = 'closed', closed_manually = 1,
        sim_exit_fill_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), sim_exit_fill_price_usd = @exitPriceUsd,
        exit_liquidity_usd = @exitLiquidityUsd, exit_market_cap_usd = @exitMarketCapUsd,
        pnl_usd = @pnlUsd, pnl_pct = @pnlPct,
        own_exit_tx_signature = COALESCE(@ownExitTxSignature, own_exit_tx_signature),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = @tradeId`,
    )
    .run({ ...input, ownExitTxSignature: input.ownExitTxSignature ?? null, pnlUsd, pnlPct });
}

export function markExitUnfillable(tradeId: number): void {
  getDb()
    .prepare(
      `UPDATE tail_trades SET status = 'unfillable_exit', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    )
    .run(tradeId);
}

/** Backfills a real ticker onto a row that was recorded with the shortened-address fallback -- see dashboardRoutes.ts's self-healing re-resolve on read. */
export function updateTailTradeSymbol(tradeId: number, symbol: string): void {
  getDb()
    .prepare(`UPDATE tail_trades SET token_symbol = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(symbol, tradeId);
}

export function getAllTailTrades(walletAddress?: string, limit = 500): TailTradeRow[] {
  if (walletAddress) {
    return getDb()
      .prepare(`SELECT * FROM tail_trades WHERE wallet_address = ? ORDER BY created_at DESC LIMIT ?`)
      .all(walletAddress, limit) as TailTradeRow[];
  }
  return getDb().prepare(`SELECT * FROM tail_trades ORDER BY created_at DESC LIMIT ?`).all(limit) as TailTradeRow[];
}

export function getTailTradesSince(sinceIso: string): TailTradeRow[] {
  return getDb()
    .prepare(`SELECT * FROM tail_trades WHERE created_at >= ? ORDER BY created_at DESC`)
    .all(sinceIso) as TailTradeRow[];
}

// ---- tail_webhook_log ----

export type TailWebhookLogStatus =
  | "parsed_buy"
  | "parsed_sell"
  | "ignored_non_swap"
  | "ignored_duplicate"
  | "ignored_already_open"
  | "ignored_no_open_position"
  | "parse_error"
  | "auth_rejected";

export function insertTailWebhookLog(
  walletAddress: string | null,
  txSignature: string | null,
  status: TailWebhookLogStatus,
  detail: string,
): void {
  getDb()
    .prepare(`INSERT INTO tail_webhook_log (wallet_address, tx_signature, status, detail) VALUES (?, ?, ?, ?)`)
    .run(walletAddress, txSignature, status, detail);
}

export interface TailWebhookLogRow {
  id: number;
  wallet_address: string | null;
  received_at: string;
  tx_signature: string | null;
  status: TailWebhookLogStatus;
  detail: string | null;
}

export function getRecentTailWebhookLog(limit = 100): TailWebhookLogRow[] {
  return getDb()
    .prepare(`SELECT * FROM tail_webhook_log ORDER BY received_at DESC LIMIT ?`)
    .all(limit) as TailWebhookLogRow[];
}

export function getLastTailWebhookReceivedAt(): string | undefined {
  const row = getDb().prepare(`SELECT received_at FROM tail_webhook_log ORDER BY received_at DESC LIMIT 1`).get() as
    | { received_at: string }
    | undefined;
  return row?.received_at;
}

// ---- tail_coverage_gaps ----

export function insertTailCoverageGap(walletAddress: string | null, gapStartedAt: string | null, reason: "handler_error" | "startup_gap", detail: string): void {
  getDb()
    .prepare(`INSERT INTO tail_coverage_gaps (wallet_address, gap_started_at, reason, detail) VALUES (?, ?, ?, ?)`)
    .run(walletAddress, gapStartedAt, reason, detail);
}

export interface TailCoverageGapRow {
  id: number;
  wallet_address: string | null;
  gap_started_at: string | null;
  detected_at: string;
  reason: "handler_error" | "startup_gap";
  detail: string;
}

export function getRecentTailCoverageGaps(limit = 50): TailCoverageGapRow[] {
  return getDb()
    .prepare(`SELECT * FROM tail_coverage_gaps ORDER BY detected_at DESC LIMIT ?`)
    .all(limit) as TailCoverageGapRow[];
}

// ---- tail_live_daily_state (live-trading daily loss cap) ----

export interface TailLiveDailySnapshot {
  snapshotDate: string | null; // UTC 'YYYY-MM-DD', null if never snapshotted
  snapshotBalanceUsd: number | null;
}

export function getTailLiveDailySnapshot(): TailLiveDailySnapshot {
  const row = getDb()
    .prepare(`SELECT snapshot_date, snapshot_balance_usd FROM tail_live_daily_state WHERE id = 1`)
    .get() as { snapshot_date: string | null; snapshot_balance_usd: number | null };
  return { snapshotDate: row.snapshot_date, snapshotBalanceUsd: row.snapshot_balance_usd };
}

export function setTailLiveDailySnapshot(snapshotDate: string, snapshotBalanceUsd: number): void {
  getDb()
    .prepare(
      `UPDATE tail_live_daily_state SET snapshot_date = ?, snapshot_balance_usd = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1`,
    )
    .run(snapshotDate, snapshotBalanceUsd);
}
