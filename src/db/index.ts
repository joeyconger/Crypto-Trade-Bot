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
