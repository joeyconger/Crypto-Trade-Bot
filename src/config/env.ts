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

  // ---- Wallet-tail research module (src/tail/) -- fully separate from the
  // main strategy above: own paper balance, own DB tables, paper-only, no
  // live path. See src/tail/README.md.
  TAIL_ENABLED: boolFromString,
  // Comma-separated wallet addresses to mirror. Configurable, not hardcoded
  // -- defaults to the wallet this module was built to evaluate (omo /
  // omotrades.com) but any address(es) can be swapped in.
  TAIL_WALLET_ADDRESSES: z.string().default("HxwmEH84o3EuezCUZuBEEeKT6uMDv8R4VRi76ExB87St"),
  // Comma-separated display labels, index-aligned with TAIL_WALLET_ADDRESSES
  // (e.g. "omo,Sling" matching the addresses in the same order) -- purely
  // cosmetic, for telling multiple tailed wallets apart in the dashboard/CLI
  // per-wallet breakdown. A missing/empty entry for a given index falls back
  // to a shortened address, same convention as resolveTokenSymbol.ts.
  TAIL_WALLET_LABELS: z.string().default(""),
  // % of TAIL_STARTING_BALANCE_USD sized into each mirrored position -- this
  // module's own fixed-fraction sizing, unrelated to the main strategy's
  // riskPctPerTrade/riskPctPerTradeTierB.
  TAIL_POSITION_SIZE_PCT: z.coerce.number().positive().default(2),
  // Simulated route-building + tx submission + confirmation delay, in
  // seconds, applied between webhook detection and the paper fill lookup --
  // this is the core of what the module is testing (edge lost to lag), not
  // a knob to tune for better-looking results.
  TAIL_SIMULATED_DELAY_SECONDS: z.coerce.number().nonnegative().default(5),
  TAIL_STARTING_BALANCE_USD: z.coerce.number().positive().default(1000),
  // Shared secret expected on incoming webhook calls (the exact value you
  // configure as the "Authorization Header" when creating the Helius
  // webhook). Optional but strongly recommended -- unset means the webhook
  // endpoint accepts unauthenticated POSTs from anyone who finds the URL.
  TAIL_WEBHOOK_SECRET: z.string().optional(),
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
