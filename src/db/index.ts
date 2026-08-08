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
