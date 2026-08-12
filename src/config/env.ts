import "dotenv/config";
import { z } from "zod";

const boolFromString = z
  .string()
  .optional()
  .transform((v) => v?.toLowerCase() === "true");

const envSchema = z.object({
  SOLANA_RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  BOT_PRIVATE_KEY: z.string().optional(),

  LIVE_TRADING: boolFromString,
  LIVE_TRADING_CONFIRM: boolFromString,

  HELIUS_API_KEY: z.string().optional(),
  BIRDEYE_API_KEY: z.string().optional(),

  // "geckoterminal" needs no API key (free public API) -- default here so a
  // fresh deploy works even with Birdeye's quota exhausted. Switch back to
  // "birdeye" once your plan resets/upgrades -- see README's data provider
  // section for the tradeoffs (GeckoTerminal's free tier has a tighter
  // rate limit and a couple of endpoints are best-effort/unverified).
  PRICE_PROVIDER: z.enum(["birdeye", "geckoterminal"]).default("geckoterminal"),
  // Optional but strongly recommended when PRICE_PROVIDER=geckoterminal: a
  // free CoinGecko "Demo" key (no cost) gets a dedicated rate-limit
  // allowance instead of sharing the anonymous pool with every other
  // unauthenticated caller. See data/geckoterminal.ts.
  GECKOTERMINAL_API_KEY: z.string().optional(),

  TWITTER_BEARER_TOKEN: z.string().optional(),

  DATABASE_PATH: z.string().default("./data/bot.sqlite"),
  WATCHLIST_CONFIG_PATH: z.string().default("./config/watchlist.yaml"),

  DASHBOARD_PORT: z.coerce.number().int().positive().default(4000),

  // Virtual bankroll paper mode sizes positions against. Position sizing is a
  // fixed % of this starting balance (not compounding equity) -- simple and
  // predictable for v1.
  PAPER_STARTING_BALANCE_USD: z.coerce.number().positive().default(1000),
  // 60s (not 300s) so the dynamic-watchlist scan budget in engine/loop.ts
  // can spread ~100 tokens' worth of scanning evenly across each
  // technicalRefreshIntervalMinutes window instead of lumping it into a
  // handful of large bursts. Ticks are cheap when nothing's due -- this
  // doesn't cost extra API calls on its own.
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
});

export type Env = z.infer<typeof envSchema> & {
  /** True only when both LIVE_TRADING and LIVE_TRADING_CONFIRM are explicitly "true". */
  liveTradingEnabled: boolean;
};

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }

  const data = parsed.data;

  // Both flags must be explicitly set to enable live trading. Requiring two
  // separate env vars means a single accidental "true" can't flip the bot
  // into placing real transactions.
  const liveTradingEnabled = data.LIVE_TRADING === true && data.LIVE_TRADING_CONFIRM === true;

  return { ...data, liveTradingEnabled };
}

export const env = loadEnv();
