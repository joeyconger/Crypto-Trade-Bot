import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

const entrySchema = z.object({
  address: z.string(),
  tag: z.enum(["exchange", "bridge", "market_maker"]),
  note: z.string().optional(),
});

const fileSchema = z.object({ wallets: z.array(entrySchema).default([]) });

let cache: Map<string, string> | undefined;

function load(): Map<string, string> {
  if (cache) return cache;
  cache = new Map();

  const filePath = path.resolve("config/known-wallets.yaml");
  if (!fs.existsSync(filePath)) return cache;

  const raw = yaml.load(fs.readFileSync(filePath, "utf8"));
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("Invalid config/known-wallets.yaml:", parsed.error.flatten());
    return cache;
  }

  for (const entry of parsed.data.wallets) cache.set(entry.address, entry.tag);
  return cache;
}

/** Returns 'exchange' | 'bridge' | 'market_maker' if the wallet is in the user-maintained denylist, else null. */
export function getKnownWalletTag(address: string): string | null {
  return load().get(address) ?? null;
}
