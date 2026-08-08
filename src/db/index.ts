import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { env } from "../config/env.js";
import type { WatchlistConfig } from "../types/index.js";

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
 * Resyncs watchlist_tokens from the YAML config (the source of truth).
 * Tokens removed from the YAML are disabled, not deleted, so historical
 * trades/signal_log rows keep a valid foreign key.
 */
export function syncWatchlistTokens(config: WatchlistConfig): void {
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
    WHERE address NOT IN (${config.tokens.map(() => "?").join(",") || "''"}) AND enabled = 1
  `);

  const tx = db.transaction((tokens: WatchlistConfig["tokens"]) => {
    for (const token of tokens) {
      upsert.run({
        address: token.address,
        symbol: token.symbol,
        enabled: token.enabled ? 1 : 0,
        config_json: JSON.stringify(token),
      });
    }
    disableMissing.run(...tokens.map((t) => t.address));
  });

  tx(config.tokens);
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

export interface OnchainSnapshotRow {
  liquidity_usd: number;
  volume_24h_usd: number;
  captured_at: string;
}

export function insertOnchainSnapshot(tokenAddress: string, liquidityUsd: number, volume24hUsd: number): void {
  getDb()
    .prepare(`INSERT INTO onchain_snapshots (token_address, liquidity_usd, volume_24h_usd) VALUES (?, ?, ?)`)
    .run(tokenAddress, liquidityUsd, volume24hUsd);
}

export function getRecentOnchainSnapshots(tokenAddress: string, limit = 10): OnchainSnapshotRow[] {
  return getDb()
    .prepare(
      `SELECT liquidity_usd, volume_24h_usd, captured_at FROM onchain_snapshots
       WHERE token_address = ? ORDER BY captured_at DESC LIMIT ?`,
    )
    .all(tokenAddress, limit) as OnchainSnapshotRow[];
}

export interface SignalLogInput {
  tokenAddress: string;
  tokenSymbol: string;
  technicalScore: number;
  onchainScore: number;
  socialScore: number;
  combinedScore: number;
  technicalDetail: string;
  onchainDetail: string;
  socialDetail: string;
  actionTaken: "none" | "buy" | "sell";
  tradeId?: number;
}

/** Inserts one signal_log row and returns its id, for later linking to a trade. */
export function insertSignalLog(input: SignalLogInput): number {
  const result = getDb()
    .prepare(
      `INSERT INTO signal_log (
        token_address, token_symbol, technical_score, onchain_score, social_score,
        combined_score, technical_detail, onchain_detail, social_detail, action_taken, trade_id
      ) VALUES (
        @tokenAddress, @tokenSymbol, @technicalScore, @onchainScore, @socialScore,
        @combinedScore, @technicalDetail, @onchainDetail, @socialDetail, @actionTaken, @tradeId
      )`,
    )
    .run({ ...input, tradeId: input.tradeId ?? null });

  return Number(result.lastInsertRowid);
}

export function attachTradeToSignalLog(signalLogId: number, tradeId: number): void {
  getDb().prepare(`UPDATE signal_log SET trade_id = ? WHERE id = ?`).run(tradeId, signalLogId);
}

export interface TradeRow {
  id: number;
  token_address: string;
  token_symbol: string;
  mode: "paper" | "live";
  side: "buy" | "sell";
  status: "open" | "closed";
  entry_price: number;
  exit_price: number | null;
  quantity: number;
  usd_size: number;
  stop_loss_price: number | null;
  take_profit_price: number | null;
  reason: string | null;
  tx_signature: string | null;
  pnl_usd: number | null;
  pnl_pct: number | null;
  opened_at: string;
  closed_at: string | null;
}

export function getOpenTrades(): TradeRow[] {
  return getDb().prepare(`SELECT * FROM trades WHERE status = 'open' ORDER BY opened_at DESC`).all() as TradeRow[];
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

export function getClosedTrades(limit = 50): TradeRow[] {
  return getDb()
    .prepare(`SELECT * FROM trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT ?`)
    .all(limit) as TradeRow[];
}

export function getRealizedPnlAllTime(): number {
  const row = getDb()
    .prepare(`SELECT COALESCE(SUM(pnl_usd), 0) as total FROM trades WHERE status = 'closed'`)
    .get() as { total: number };
  return row.total;
}

export interface SignalLogRow {
  id: number;
  token_address: string;
  token_symbol: string;
  evaluated_at: string;
  technical_score: number | null;
  onchain_score: number | null;
  social_score: number | null;
  combined_score: number | null;
  technical_detail: string | null;
  onchain_detail: string | null;
  social_detail: string | null;
  action_taken: "none" | "buy" | "sell";
  trade_id: number | null;
}

export function getSignalLog(limit = 100): SignalLogRow[] {
  return getDb().prepare(`SELECT * FROM signal_log ORDER BY evaluated_at DESC LIMIT ?`).all(limit) as SignalLogRow[];
}

export function getBotState(): { paused: boolean } {
  const row = getDb().prepare(`SELECT paused FROM bot_state WHERE id = 1`).get() as { paused: number } | undefined;
  return { paused: !!row?.paused };
}

export function setPaused(paused: boolean): void {
  getDb()
    .prepare(`UPDATE bot_state SET paused = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1`)
    .run(paused ? 1 : 0);
}
