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

  TWITTER_BEARER_TOKEN: z.string().optional(),

  DATABASE_PATH: z.string().default("./data/bot.sqlite"),
  WATCHLIST_CONFIG_PATH: z.string().default("./config/watchlist.yaml"),

  DASHBOARD_PORT: z.coerce.number().int().positive().default(4000),

  // Virtual bankroll paper mode sizes positions against. Position sizing is a
  // fixed % of this starting balance (not compounding equity) -- simple and
  // predictable for v1.
  PAPER_STARTING_BALANCE_USD: z.coerce.number().positive().default(1000),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
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
