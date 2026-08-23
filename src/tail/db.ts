import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let initialized = false;

/** Applies tail_*'s own schema against the shared DB connection. Idempotent (CREATE TABLE IF NOT EXISTS), safe to call on every startup. */
export function initTailSchema(): void {
  if (initialized) return;
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  getDb().exec(schema);
  initialized = true;
}

export function upsertTailWallet(address: string, label: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO tail_wallets (address, label) VALUES (?, ?)
       ON CONFLICT(address) DO UPDATE SET label = excluded.label`,
    )
    .run(address, label);
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
  entry_slippage_vs_wallet_pct: number | null;
  wallet_exit_price_usd: number | null;
  wallet_exit_tx_signature: string | null;
  wallet_exit_onchain_at: string | null;
  exit_detected_at: string | null;
  exit_detection_latency_ms: number | null;
  sim_exit_fill_at: string | null;
  sim_exit_fill_price_usd: number | null;
  exit_liquidity_usd: number | null;
  exit_slippage_vs_wallet_pct: number | null;
  pnl_usd: number | null;
  pnl_pct: number | null;
  wallet_exact_pnl_usd: number | null;
  wallet_exact_pnl_pct: number | null;
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
}

/** Inserts the row immediately on detection, before the delayed sim fill is known -- status/quantity/sim fields are filled in by recordEntryFill once the simulated delay elapses. */
export function insertPendingTailEntry(input: OpenTailEntryInput): number {
  const result = getDb()
    .prepare(
      `INSERT INTO tail_trades (
        wallet_address, token_address, token_symbol, status, usd_size,
        wallet_entry_price_usd, wallet_entry_tx_signature, wallet_entry_onchain_at,
        entry_detected_at, entry_detection_latency_ms
      ) VALUES (
        @walletAddress, @tokenAddress, @tokenSymbol, 'open', @usdSize,
        @walletEntryPriceUsd, @walletEntryTxSignature, @walletEntryOnchainAt,
        @entryDetectedAt, @entryDetectionLatencyMs
      )`,
    )
    .run(input);
  return Number(result.lastInsertRowid);
}

export interface EntryFillResult {
  tradeId: number;
  simEntryFillAt: string;
  simEntryFillPriceUsd: number;
  entryLiquidityUsd: number;
  quantity: number;
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
        entry_liquidity_usd = @entryLiquidityUsd, entry_slippage_vs_wallet_pct = @entrySlippageVsWalletPct,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = @tradeId`,
    )
    .run({ ...input, entrySlippageVsWalletPct });
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
  simExitFillPriceUsd: number;
  exitLiquidityUsd: number;
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
        exit_liquidity_usd = @exitLiquidityUsd, exit_slippage_vs_wallet_pct = @exitSlippageVsWalletPct,
        pnl_usd = @pnlUsd, pnl_pct = @pnlPct,
        wallet_exact_pnl_usd = @walletExactPnlUsd, wallet_exact_pnl_pct = @walletExactPnlPct,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = @tradeId`,
    )
    .run({ ...input, exitSlippageVsWalletPct, pnlUsd, pnlPct, walletExactPnlUsd, walletExactPnlPct });
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
