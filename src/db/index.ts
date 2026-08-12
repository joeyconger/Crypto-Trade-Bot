import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { env } from "../config/env.js";
import type { TokenConfig } from "../types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let dbInstance: Database.Database | undefined;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const dbPath = path.resolve(env.DATABASE_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  dbInstance = new Database(dbPath);
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("foreign_keys = ON");

  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  dbInstance.exec(schema);

  return dbInstance;
}

/**
 * Resyncs watchlist_tokens from the given list (the YAML's static tokens, or
 * the current top-traded selection). Tokens no longer present are disabled,
 * not deleted, so historical trades/signal_log rows keep a valid foreign key.
 */
export function syncWatchlistTokens(tokens: TokenConfig[]): void {
  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO watchlist_tokens (address, symbol, enabled, config_json, updated_at)
    VALUES (@address, @symbol, @enabled, @config_json, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(address) DO UPDATE SET
      symbol = excluded.symbol,
      enabled = excluded.enabled,
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
  `);

  const disableMissing = db.prepare(`
    UPDATE watchlist_tokens SET enabled = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE address NOT IN (${tokens.map(() => "?").join(",") || "''"}) AND enabled = 1
  `);

  const tx = db.transaction((list: TokenConfig[]) => {
    for (const token of list) {
      upsert.run({
        address: token.address,
        symbol: token.symbol,
        enabled: token.enabled ? 1 : 0,
        config_json: JSON.stringify(token),
      });
    }
    disableMissing.run(...list.map((t) => t.address));
  });

  tx(tokens);
}

/** Reconstructs the currently-enabled watchlist from the DB (each token's full config, as last synced). */
export function getWatchlistTokensFromDb(): TokenConfig[] {
  const rows = getDb()
    .prepare(`SELECT config_json FROM watchlist_tokens WHERE enabled = 1`)
    .all() as { config_json: string }[];
  return rows.map((r) => JSON.parse(r.config_json) as TokenConfig);
}

export function getWatchlistLastRefreshedAt(): string | undefined {
  const row = getDb().prepare(`SELECT watchlist_last_refreshed_at FROM bot_state WHERE id = 1`).get() as
    | { watchlist_last_refreshed_at: string | null }
    | undefined;
  return row?.watchlist_last_refreshed_at ?? undefined;
}

export function setWatchlistLastRefreshedAt(iso: string): void {
  getDb()
    .prepare(`UPDATE bot_state SET watchlist_last_refreshed_at = ? WHERE id = 1`)
    .run(iso);
}

export function getWatchlistLastAttemptedAt(): string | undefined {
  const row = getDb().prepare(`SELECT watchlist_last_attempted_at FROM bot_state WHERE id = 1`).get() as
    | { watchlist_last_attempted_at: string | null }
    | undefined;
  return row?.watchlist_last_attempted_at ?? undefined;
}

/** Stamps a refresh attempt and records its outcome -- pass null to clear the error on success. */
export function setWatchlistAttempt(iso: string, error: string | null): void {
  getDb()
    .prepare(`UPDATE bot_state SET watchlist_last_attempted_at = ?, watchlist_last_error = ? WHERE id = 1`)
    .run(iso, error);
}

export function getWatchlistRefreshError(): string | undefined {
  const row = getDb().prepare(`SELECT watchlist_last_error FROM bot_state WHERE id = 1`).get() as
    | { watchlist_last_error: string | null }
    | undefined;
  return row?.watchlist_last_error ?? undefined;
}

/** All tokens' last technical-eval timestamps in one query, for the poll loop's per-cycle due-check across the whole watchlist. */
export function getLastTechnicalEvalAtMap(): Map<string, string> {
  const rows = getDb()
    .prepare(`SELECT address, last_technical_eval_at FROM watchlist_tokens WHERE last_technical_eval_at IS NOT NULL`)
    .all() as { address: string; last_technical_eval_at: string }[];
  return new Map(rows.map((r) => [r.address, r.last_technical_eval_at]));
}

export function setLastTechnicalEvalAt(tokenAddress: string, iso: string): void {
  getDb().prepare(`UPDATE watchlist_tokens SET last_technical_eval_at = ? WHERE address = ?`).run(iso, tokenAddress);
}

// ---- token_pool_cache (GeckoTerminal provider only) ----

export function getCachedPoolAddress(tokenAddress: string): string | undefined {
  const row = getDb().prepare(`SELECT pool_address FROM token_pool_cache WHERE token_address = ?`).get(tokenAddress) as
    | { pool_address: string }
    | undefined;
  return row?.pool_address;
}

export function setCachedPoolAddress(tokenAddress: string, poolAddress: string): void {
  getDb()
    .prepare(
      `INSERT INTO token_pool_cache (token_address, pool_address) VALUES (?, ?)
       ON CONFLICT(token_address) DO UPDATE SET pool_address = excluded.pool_address, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(tokenAddress, poolAddress);
}

export function getLastTxSignature(tokenAddress: string): string | undefined {
  const row = getDb()
    .prepare(`SELECT last_tx_signature FROM watchlist_tokens WHERE address = ?`)
    .get(tokenAddress) as { last_tx_signature: string | null } | undefined;
  return row?.last_tx_signature ?? undefined;
}

export function setLastTxSignature(tokenAddress: string, signature: string): void {
  getDb()
    .prepare(
      `UPDATE watchlist_tokens SET last_tx_signature = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE address = ?`,
    )
    .run(signature, tokenAddress);
}

// ---- wallet_activity ----

export interface WalletActivityInput {
  walletAddress: string;
  tokenAddress: string;
  side: "buy" | "sell";
  usdSize: number;
  txSignature: string;
}

/** Records one observed trade. INSERT OR IGNORE tolerates re-processing the same tx (tx_signature is UNIQUE). */
export function insertWalletActivity(input: WalletActivityInput): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO wallet_activity (wallet_address, token_address, side, usd_size, tx_signature)
       VALUES (@walletAddress, @tokenAddress, @side, @usdSize, @txSignature)`,
    )
    .run(input);
}

export interface WalletActivityRow {
  id: number;
  wallet_address: string;
  token_address: string;
  side: "buy" | "sell";
  usd_size: number;
  tx_signature: string;
  observed_at: string;
}

export function getWalletActivity(walletAddress: string, limit = 50): WalletActivityRow[] {
  return getDb()
    .prepare(`SELECT * FROM wallet_activity WHERE wallet_address = ? ORDER BY observed_at DESC LIMIT ?`)
    .all(walletAddress, limit) as WalletActivityRow[];
}

export function getWalletBuysForTokenSince(tokenAddress: string, sinceIso: string): WalletActivityRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM wallet_activity WHERE token_address = ? AND side = 'buy' AND observed_at >= ? ORDER BY observed_at ASC`,
    )
    .all(tokenAddress, sinceIso) as WalletActivityRow[];
}

/** Signal-reversal check: has any of these (tracked) wallets sold this token since the given time? */
export function hasWalletSoldTokenSince(walletAddresses: string[], tokenAddress: string, sinceIso: string): boolean {
  if (walletAddresses.length === 0) return false;
  const placeholders = walletAddresses.map(() => "?").join(",");
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) as n FROM wallet_activity
       WHERE token_address = ? AND side = 'sell' AND observed_at >= ? AND wallet_address IN (${placeholders})`,
    )
    .get(tokenAddress, sinceIso, ...walletAddresses) as { n: number };
  return row.n > 0;
}

// ---- wallet_reputation ----

export interface WalletReputationRow {
  wallet_address: string;
  tag: string | null;
  first_tx_at: string | null;
  history_tx_count: number;
  age_checked_at: string | null;
  reputation_score: number;
  updated_at: string;
}

export function getWalletReputation(walletAddress: string): WalletReputationRow | undefined {
  return getDb().prepare(`SELECT * FROM wallet_reputation WHERE wallet_address = ?`).get(walletAddress) as
    | WalletReputationRow
    | undefined;
}

/** Caches the (expensive) Helius-derived age lookup and config-derived tag so we don't refetch every cycle. */
export function upsertWalletAgeAndTag(
  walletAddress: string,
  firstTxAt: string | null,
  historyTxCount: number,
  tag: string | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO wallet_reputation (wallet_address, tag, first_tx_at, history_tx_count, age_checked_at, reputation_score)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0)
       ON CONFLICT(wallet_address) DO UPDATE SET
         tag = excluded.tag, first_tx_at = excluded.first_tx_at,
         history_tx_count = excluded.history_tx_count, age_checked_at = excluded.age_checked_at`,
    )
    .run(walletAddress, tag, firstTxAt, historyTxCount);
}

export function updateWalletReputationScore(walletAddress: string, score: number): void {
  getDb()
    .prepare(
      `UPDATE wallet_reputation SET reputation_score = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE wallet_address = ?`,
    )
    .run(score, walletAddress);
}

// ---- trades ----

export interface TradeRow {
  id: number;
  token_address: string;
  token_symbol: string;
  mode: "paper" | "live";
  side: "buy" | "sell";
  status: "open" | "closed";
  entry_price: number;
  quantity: number;
  quantity_remaining: number;
  usd_size: number;
  swing_high: number;
  swing_low: number;
  fib_zone_level: number;
  atr_at_entry: number;
  extension_1272_price: number;
  extension_1618_price: number;
  stop_price: number;
  scale_out_1_done: number;
  scale_out_2_done: number;
  runner_active: number;
  time_exit_deadline: string;
  confluence_tier: "A" | "B";
  reason: string | null;
  tx_signature: string | null;
  exit_price: number | null;
  pnl_usd: number | null;
  pnl_pct: number | null;
  opened_at: string;
  closed_at: string | null;
}

/**
 * Everything about a trade that's known before it executes -- independent of
 * whether the fill is a simulated paper price or an actual swap result.
 * entry_price/quantity are determined by the fill mechanics (paper: current
 * price; live: actual on-chain balance delta after slippage), so they're
 * not part of the plan.
 */
export interface PlannedTradeInput {
  tokenAddress: string;
  tokenSymbol: string;
  usdSize: number;
  swingHigh: number;
  swingLow: number;
  fibZoneLevel: number;
  atrAtEntry: number;
  extension1272Price: number;
  extension1618Price: number;
  stopPrice: number;
  timeExitDeadline: string;
  confluenceTier: "A" | "B";
  reason: string;
}

export interface NewTradeInput extends PlannedTradeInput {
  mode: "paper" | "live";
  entryPrice: number;
  quantity: number;
  txSignature?: string;
}

export function insertTrade(input: NewTradeInput): number {
  const result = getDb()
    .prepare(
      `INSERT INTO trades (
        token_address, token_symbol, mode, side, status,
        entry_price, quantity, quantity_remaining, usd_size,
        swing_high, swing_low, fib_zone_level, atr_at_entry,
        extension_1272_price, extension_1618_price, stop_price,
        time_exit_deadline, confluence_tier, reason, tx_signature
      ) VALUES (
        @tokenAddress, @tokenSymbol, @mode, 'buy', 'open',
        @entryPrice, @quantity, @quantity, @usdSize,
        @swingHigh, @swingLow, @fibZoneLevel, @atrAtEntry,
        @extension1272Price, @extension1618Price, @stopPrice,
        @timeExitDeadline, @confluenceTier, @reason, @txSignature
      )`,
    )
    .run({ ...input, txSignature: input.txSignature ?? null });

  return Number(result.lastInsertRowid);
}

export function getOpenTrades(): TradeRow[] {
  return getDb().prepare(`SELECT * FROM trades WHERE status = 'open' ORDER BY opened_at DESC`).all() as TradeRow[];
}

/** Cheap count-only query for the concurrent-position cap check -- no need to materialize full rows. */
export function getOpenPositionCount(mode: "paper" | "live"): number {
  const row = getDb().prepare(`SELECT COUNT(*) as n FROM trades WHERE status = 'open' AND mode = ?`).get(mode) as { n: number };
  return row.n;
}

/**
 * At most one open position per token at a time, scoped to the current mode
 * so a leftover paper position (e.g. from testing) can never block or get
 * confused with a live one on the same token, or vice versa.
 */
export function getOpenTrade(tokenAddress: string, mode: "paper" | "live"): TradeRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM trades WHERE token_address = ? AND status = 'open' AND mode = ? LIMIT 1`)
    .get(tokenAddress, mode) as TradeRow | undefined;
}

export function getTradeById(id: number): TradeRow | undefined {
  return getDb().prepare(`SELECT * FROM trades WHERE id = ?`).get(id) as TradeRow | undefined;
}

export function getClosedTrades(limit = 50): TradeRow[] {
  return getDb()
    .prepare(`SELECT * FROM trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT ?`)
    .all(limit) as TradeRow[];
}

export function getRealizedPnlSince(mode: "paper" | "live", sinceIso: string): number {
  const row = getDb()
    .prepare(`SELECT COALESCE(SUM(pnl_usd), 0) as total FROM trades WHERE status = 'closed' AND mode = ? AND closed_at >= ?`)
    .get(mode, sinceIso) as { total: number };
  return row.total;
}

export function getRealizedPnlAllTime(): number {
  const row = getDb()
    .prepare(`SELECT COALESCE(SUM(pnl_usd), 0) as total FROM trades WHERE status = 'closed'`)
    .get() as { total: number };
  return row.total;
}

export function updateTradeStopPrice(tradeId: number, stopPrice: number): void {
  getDb().prepare(`UPDATE trades SET stop_price = ? WHERE id = ?`).run(stopPrice, tradeId);
}

/** Advances the runner's trailing stop and the swing-high it's measured against (used to detect "new highs"). */
export function updateTradeTrailingStop(tradeId: number, stopPrice: number, swingHigh: number): void {
  getDb().prepare(`UPDATE trades SET stop_price = ?, swing_high = ? WHERE id = ?`).run(stopPrice, swingHigh, tradeId);
}

export function markScaleOut1Done(tradeId: number, quantityRemaining: number): void {
  getDb()
    .prepare(`UPDATE trades SET scale_out_1_done = 1, quantity_remaining = ? WHERE id = ?`)
    .run(quantityRemaining, tradeId);
}

export function markScaleOut2Done(tradeId: number, quantityRemaining: number, runnerStopPrice: number): void {
  getDb()
    .prepare(
      `UPDATE trades SET scale_out_2_done = 1, runner_active = 1, quantity_remaining = ?, stop_price = ? WHERE id = ?`,
    )
    .run(quantityRemaining, runnerStopPrice, tradeId);
}

/** Aggregates all position_exits for a trade into its final exit_price/pnl and marks it closed. */
export function closeTradeFully(tradeId: number): void {
  const db = getDb();
  const exits = db
    .prepare(`SELECT quantity, exit_price, pnl_usd FROM position_exits WHERE trade_id = ?`)
    .all(tradeId) as { quantity: number; exit_price: number; pnl_usd: number }[];
  const trade = db.prepare(`SELECT usd_size FROM trades WHERE id = ?`).get(tradeId) as { usd_size: number };

  const totalQuantity = exits.reduce((sum, e) => sum + e.quantity, 0);
  const weightedExitPrice =
    totalQuantity > 0 ? exits.reduce((sum, e) => sum + e.exit_price * e.quantity, 0) / totalQuantity : 0;
  const totalPnlUsd = exits.reduce((sum, e) => sum + e.pnl_usd, 0);
  const pnlPct = trade.usd_size > 0 ? (totalPnlUsd / trade.usd_size) * 100 : 0;

  db.prepare(
    `UPDATE trades
     SET status = 'closed', quantity_remaining = 0, exit_price = ?, pnl_usd = ?, pnl_pct = ?,
         closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
  ).run(weightedExitPrice, totalPnlUsd, pnlPct, tradeId);
}

// ---- position_exits ----

export interface PositionExitInput {
  tradeId: number;
  tranche: "scale_1" | "scale_2" | "runner";
  quantity: number;
  exitPrice: number;
  exitReason: string;
  pnlUsd: number;
  txSignature?: string;
}

export function insertPositionExit(input: PositionExitInput): void {
  getDb()
    .prepare(
      `INSERT INTO position_exits (trade_id, tranche, quantity, exit_price, exit_reason, pnl_usd, tx_signature)
       VALUES (@tradeId, @tranche, @quantity, @exitPrice, @exitReason, @pnlUsd, @txSignature)`,
    )
    .run({ ...input, txSignature: input.txSignature ?? null });
}

export interface PositionExitRow {
  id: number;
  trade_id: number;
  tranche: "scale_1" | "scale_2" | "runner";
  quantity: number;
  exit_price: number;
  exit_reason: string;
  pnl_usd: number;
  tx_signature: string | null;
  exited_at: string;
}

export function getPositionExits(tradeId: number): PositionExitRow[] {
  return getDb()
    .prepare(`SELECT * FROM position_exits WHERE trade_id = ? ORDER BY exited_at ASC`)
    .all(tradeId) as PositionExitRow[];
}

// ---- trade_signal_wallets ----

export interface TradeSignalWalletInput {
  tradeId: number;
  walletAddress: string;
  usdSize: number;
  reputationScore: number;
  walletAgeDays: number | null;
  txSignature: string;
}

export function insertTradeSignalWallet(input: TradeSignalWalletInput): void {
  getDb()
    .prepare(
      `INSERT INTO trade_signal_wallets (trade_id, wallet_address, usd_size, reputation_score, wallet_age_days, tx_signature)
       VALUES (@tradeId, @walletAddress, @usdSize, @reputationScore, @walletAgeDays, @txSignature)`,
    )
    .run(input);
}

export interface TradeSignalWalletRow {
  id: number;
  trade_id: number;
  wallet_address: string;
  usd_size: number;
  reputation_score: number;
  wallet_age_days: number | null;
  tx_signature: string;
}

export function getTradeSignalWallets(tradeId: number): TradeSignalWalletRow[] {
  return getDb().prepare(`SELECT * FROM trade_signal_wallets WHERE trade_id = ?`).all(tradeId) as TradeSignalWalletRow[];
}

// ---- signal_log ----

export interface SignalLogInput {
  tokenAddress: string;
  tokenSymbol: string;
  technicalTriggerPassed: boolean;
  onchainConfluencePresent: boolean;
  actionTaken: "none" | "buy" | "sell";
  detail: string;
  tradeId?: number;
}

export function insertSignalLog(input: SignalLogInput): number {
  const result = getDb()
    .prepare(
      `INSERT INTO signal_log (token_address, token_symbol, technical_trigger_passed, onchain_confluence_present, action_taken, detail, trade_id)
       VALUES (@tokenAddress, @tokenSymbol, @technicalTriggerPassed, @onchainConfluencePresent, @actionTaken, @detail, @tradeId)`,
    )
    .run({
      tokenAddress: input.tokenAddress,
      tokenSymbol: input.tokenSymbol,
      technicalTriggerPassed: input.technicalTriggerPassed ? 1 : 0,
      onchainConfluencePresent: input.onchainConfluencePresent ? 1 : 0,
      actionTaken: input.actionTaken,
      detail: input.detail,
      tradeId: input.tradeId ?? null,
    });

  return Number(result.lastInsertRowid);
}

export function attachTradeToSignalLog(signalLogId: number, tradeId: number): void {
  getDb().prepare(`UPDATE signal_log SET trade_id = ? WHERE id = ?`).run(tradeId, signalLogId);
}

export interface SignalLogRow {
  id: number;
  token_address: string;
  token_symbol: string;
  evaluated_at: string;
  technical_trigger_passed: number;
  onchain_confluence_present: number;
  action_taken: "none" | "buy" | "sell";
  detail: string | null;
  trade_id: number | null;
}

export function getSignalLog(limit = 100): SignalLogRow[] {
  return getDb().prepare(`SELECT * FROM signal_log ORDER BY evaluated_at DESC LIMIT ?`).all(limit) as SignalLogRow[];
}

// ---- bot_state ----

export function getBotState(): { paused: boolean } {
  const row = getDb().prepare(`SELECT paused FROM bot_state WHERE id = 1`).get() as { paused: number } | undefined;
  return { paused: !!row?.paused };
}

export function setPaused(paused: boolean): void {
  getDb()
    .prepare(`UPDATE bot_state SET paused = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1`)
    .run(paused ? 1 : 0);
}

// ---- circuit_breaker_state ----

export interface CircuitBreakerStateRow {
  weekly_halted: number;
  consecutive_losses: number;
  consecutive_loss_halted: number;
}

export function getCircuitBreakerState(): CircuitBreakerStateRow {
  return getDb()
    .prepare(`SELECT weekly_halted, consecutive_losses, consecutive_loss_halted FROM circuit_breaker_state WHERE id = 1`)
    .get() as CircuitBreakerStateRow;
}

export function setWeeklyHalted(halted: boolean): void {
  getDb()
    .prepare(
      `UPDATE circuit_breaker_state SET weekly_halted = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1`,
    )
    .run(halted ? 1 : 0);
}

/** Increments on a loss, resets to 0 on a win/breakeven. Returns the new count -- the threshold check lives in execution/circuitBreakers.ts. */
export function incrementOrResetConsecutiveLosses(isLoss: boolean): number {
  const current = getCircuitBreakerState();
  const consecutiveLosses = isLoss ? current.consecutive_losses + 1 : 0;
  getDb()
    .prepare(
      `UPDATE circuit_breaker_state SET consecutive_losses = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1`,
    )
    .run(consecutiveLosses);
  return consecutiveLosses;
}

export function setConsecutiveLossHalted(halted: boolean): void {
  getDb()
    .prepare(
      `UPDATE circuit_breaker_state SET consecutive_loss_halted = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1`,
    )
    .run(halted ? 1 : 0);
}

export function resumeConsecutiveLossHalt(): void {
  getDb()
    .prepare(
      `UPDATE circuit_breaker_state
       SET consecutive_loss_halted = 0, consecutive_losses = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = 1`,
    )
    .run();
}
