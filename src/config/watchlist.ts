import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { StrategyConfig, WatchlistConfig } from "../types/index.js";
import { env } from "./env.js";

const strategyConfigSchema = z.object({
  fibPivotWindow: z.number().int().positive(),
  goldenPocketZonePct: z.number().positive(),
  swingLookbackHours: z.number().positive(),

  trendSmaPeriod: z.number().int().positive(),
  chopLookbackPeriods: z.number().int().positive(),
  chopMaxCrossings: z.number().int().positive(),

  rsiPeriod: z.number().int().positive(),
  rsiMidline: z.number().min(0).max(100),
  rsiOverboughtCeiling: z.number().min(0).max(100),

  volumeAvgPeriod: z.number().int().positive(),
  volumeConfirmationMultiplier: z.number().positive(),

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

  // Default of 4h keeps a 100-token dynamic watchlist's OHLCV cost bounded
  // regardless of poll interval -- see engine/loop.ts's due-token throttle.
  technicalRefreshIntervalMinutes: z.number().positive().default(240),
});

const tokenConfigSchema = strategyConfigSchema.extend({
  symbol: z.string().min(1),
  address: z.string().min(32).max(44),
  enabled: z.boolean().default(true),
});

const riskConfigSchema = z.object({
  riskPctPerTrade: z.number().positive().max(100),
  maxPositionSizePct: z.number().positive().max(100),
  dailyLossLimitPct: z.number().positive().max(100),
  weeklyLossLimitPct: z.number().positive().max(100),
  consecutiveLossLimit: z.number().int().positive(),
});

const watchlistSourceConfigSchema = z.object({
  mode: z.enum(["static", "top_traded"]).default("static"),
  topTradedCount: z.number().int().positive().default(100),
  refreshIntervalHours: z.number().positive().default(24),
  minLiquidityUsd: z.number().nonnegative().default(50000),
});

const watchlistConfigSchema = z.object({
  tokens: z.array(tokenConfigSchema).default([]),
  risk: riskConfigSchema,
  watchlistSource: watchlistSourceConfigSchema.default({
    mode: "static",
    topTradedCount: 100,
    refreshIntervalHours: 24,
    minLiquidityUsd: 50000,
  }),
  defaultStrategy: strategyConfigSchema.optional(),
});

function validateStrategy(strategy: StrategyConfig, label: string): void {
  if (strategy.scaleOutPct1 + strategy.scaleOutPct2 >= 100) {
    throw new Error(
      `${label}: scaleOutPct1 + scaleOutPct2 must leave a remainder for the runner (got ${strategy.scaleOutPct1 + strategy.scaleOutPct2}%)`,
    );
  }
  if (strategy.extensionRatio2 <= strategy.extensionRatio1) {
    throw new Error(`${label}: extensionRatio2 must be greater than extensionRatio1`);
  }
  if (strategy.rsiOverboughtCeiling <= strategy.rsiMidline) {
    throw new Error(`${label}: rsiOverboughtCeiling must be greater than rsiMidline`);
  }
}

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

  for (const token of parsed.data.tokens) validateStrategy(token, token.symbol);

  if (parsed.data.watchlistSource.mode === "top_traded" && !parsed.data.defaultStrategy) {
    throw new Error(`watchlistSource.mode is "top_traded" but defaultStrategy is not set`);
  }
  if (parsed.data.defaultStrategy) validateStrategy(parsed.data.defaultStrategy, "defaultStrategy");

  return parsed.data as WatchlistConfig;
}
