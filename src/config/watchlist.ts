import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { WatchlistConfig } from "../types/index.js";
import { env } from "./env.js";

const tokenConfigSchema = z.object({
  symbol: z.string().min(1),
  address: z.string().min(32).max(44),
  enabled: z.boolean().default(true),

  fibPivotWindow: z.number().int().positive(),
  goldenPocketZonePct: z.number().positive(),
  swingLookbackHours: z.number().positive(),

  minBuyUsd: z.number().positive(),
  maxBuyPctOfLiquidity: z.number().positive().max(100),
  minWalletAgeDays: z.number().nonnegative(),
  minWalletPriorTrades: z.number().int().nonnegative(),
  confirmationWindowHours: z.number().positive(),
  minConfirmingWallets: z.number().int().min(2, "independent confirmation requires at least 2 wallets"),

  atrPeriod: z.number().int().positive(),
  stopAtrMultiplier: z.number().positive(),

  extensionRatio1: z.number().min(1),
  extensionRatio2: z.number().min(1),
  scaleOutPct1: z.number().positive().max(100),
  scaleOutPct2: z.number().positive().max(100),

  timeExitHours: z.number().positive(),
});

const riskConfigSchema = z.object({
  riskPctPerTrade: z.number().positive().max(100),
  maxPositionSizePct: z.number().positive().max(100),
  dailyLossLimitPct: z.number().positive().max(100),
  weeklyLossLimitPct: z.number().positive().max(100),
  consecutiveLossLimit: z.number().int().positive(),
});

const watchlistConfigSchema = z.object({
  tokens: z.array(tokenConfigSchema),
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

  for (const token of parsed.data.tokens) {
    if (token.scaleOutPct1 + token.scaleOutPct2 >= 100) {
      throw new Error(
        `${token.symbol}: scaleOutPct1 + scaleOutPct2 must leave a remainder for the runner (got ${token.scaleOutPct1 + token.scaleOutPct2}%)`,
      );
    }
    if (token.extensionRatio2 <= token.extensionRatio1) {
      throw new Error(`${token.symbol}: extensionRatio2 must be greater than extensionRatio1`);
    }
  }

  return parsed.data;
}
