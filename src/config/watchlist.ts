import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { WatchlistConfig } from "../types/index.js";
import { env } from "./env.js";

const tokenWeightsSchema = z
  .object({
    technical: z.number().min(0).max(1),
    onchain: z.number().min(0).max(1),
    social: z.number().min(0).max(1),
  })
  .refine((w) => Math.abs(w.technical + w.onchain + w.social - 1) < 1e-6, {
    message: "weights.technical + weights.onchain + weights.social must sum to 1.0",
  });

const tokenConfigSchema = z.object({
  symbol: z.string().min(1),
  address: z.string().min(32).max(44),
  enabled: z.boolean().default(true),

  fibLevels: z.array(z.number().min(0).max(1)).min(1),
  swingLookbackHours: z.number().positive(),
  confluenceZonePct: z.number().positive(),

  whaleUsdThreshold: z.number().positive(),
  volumeSpikeMultiplier: z.number().positive(),

  twitterKeywords: z.array(z.string()).default([]),

  weights: tokenWeightsSchema,

  buyThreshold: z.number().min(-1).max(1),
  sellThreshold: z.number().min(-1).max(1),

  positionSizePct: z.number().positive().max(100),
  stopLossPct: z.number().positive().max(100),
  takeProfitPct: z.number().positive(),
});

const riskConfigSchema = z.object({
  maxConcurrentPositions: z.number().int().positive(),
  maxPositionSizePct: z.number().positive().max(100),
  dailyLossLimitPct: z.number().positive().max(100),
});

const watchlistConfigSchema = z.object({
  tokens: z.array(tokenConfigSchema),
  twitterAccounts: z.array(z.string()).default([]),
  risk: riskConfigSchema,
});

export function loadWatchlistConfig(configPath: string = env.WATCHLIST_CONFIG_PATH): WatchlistConfig {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Watchlist config not found at ${resolved}`);
  }

  const raw = yaml.load(fs.readFileSync(resolved, "utf8"));
  const parsed = watchlistConfigSchema.safeParse(raw);

  if (!parsed.success) {
    console.error(`Invalid watchlist config at ${resolved}:`);
    console.error(parsed.error.flatten());
    throw new Error("Failed to load watchlist config");
  }

  const addresses = parsed.data.tokens.map((t) => t.address);
  const duplicates = addresses.filter((a, i) => addresses.indexOf(a) !== i);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate token address(es) in watchlist config: ${[...new Set(duplicates)].join(", ")}`);
  }

  return parsed.data;
}
