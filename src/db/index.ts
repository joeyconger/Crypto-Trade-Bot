import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { env } from "../config/env.js";

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

// ---- token_pool_cache (GeckoTerminal provider only) -- shared with src/tail/* via data/geckoterminal.ts ----

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
