import "dotenv/config";
import { z } from "zod";

const boolFromString = z
  .string()
  .optional()
  .transform((v) => v?.toLowerCase() === "true");

const envSchema = z.object({
  SOLANA_RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  // The bot's own dedicated wallet, generated via `npm run generate-keypair`
  // -- never your personal Phantom wallet. Only needed when tail live
  // trading is enabled (see TAIL_LIVE_TRADING below).
  BOT_PRIVATE_KEY: z.string().optional(),

  HELIUS_API_KEY: z.string().optional(),
  BIRDEYE_API_KEY: z.string().optional(),

  // Switch to "birdeye" if your Birdeye plan is active -- see README's data
  // provider section for the tradeoffs.
  PRICE_PROVIDER: z.enum(["birdeye", "geckoterminal"]).default("geckoterminal"),
  // REQUIRED when PRICE_PROVIDER=geckoterminal (the default) -- data/geckoterminal.ts
  // calls CoinGecko's keyed api.coingecko.com/api/v3/onchain host, which
  // rejects every request with a 401 if this is unset (confirmed live: it
  // does not fall back to a slower anonymous tier the way the old
  // api.geckoterminal.com/api/v2 host used to). A free CoinGecko "Demo" key,
  // no cost, no card -- coingecko.com/en/api/pricing. See data/geckoterminal.ts.
  GECKOTERMINAL_API_KEY: z.string().optional(),

  DATABASE_PATH: z.string().default("./data/bot.sqlite"),

  DASHBOARD_PORT: z.coerce.number().int().positive().default(4000),

  // ---- Wallet-tail module (src/tail/) -- mirrors specific wallets' swaps,
  // paper by default. See README's wallet-tail section.
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
  // % of TAIL_STARTING_BALANCE_USD (paper) or the live wallet's real current
  // balance (live) sized into each mirrored position.
  TAIL_POSITION_SIZE_PCT: z.coerce.number().positive().default(2),
  // Simulated route-building + tx submission + confirmation delay, in
  // seconds, applied between webhook detection and the paper fill lookup --
  // paper mode only. Live trades execute as fast as possible instead --
  // real execution latency, not an artificial one.
  TAIL_SIMULATED_DELAY_SECONDS: z.coerce.number().nonnegative().default(5),
  TAIL_STARTING_BALANCE_USD: z.coerce.number().positive().default(1000),
  // If the token's current price (checked the instant a buy is detected)
  // is already more than this % above the tailed wallet's own entry
  // price, the buy is skipped entirely -- no position opened, live or
  // paper. Guards against chasing a token that already pumped hard in the
  // detection+fill lag window (observed live: entries 30-60%+ above the
  // wallet's own price on fast-moving tokens), which is the single
  // biggest lag-cost driver seen so far.
  TAIL_MAX_ENTRY_SLIPPAGE_PCT: z.coerce.number().positive().default(15),
  // Shared secret expected on incoming webhook calls (the exact value you
  // configure as the "Authorization Header" when creating the Helius
  // webhook). Optional but strongly recommended -- unset means the webhook
  // endpoint accepts unauthenticated POSTs from anyone who finds the URL.
  TAIL_WEBHOOK_SECRET: z.string().optional(),
  // Helius webhook ID (from the webhook's URL/API response when you created
  // it, e.g. https://api.helius.xyz/v0/webhooks/<this-id>). Optional -- only
  // needed to let the dashboard's "add/remove tailed wallet" actions call
  // Helius's API to keep that webhook's watched-address list in sync
  // automatically. Without it, wallets added in the dashboard still get
  // tailed once you add them to the webhook yourself in Helius's dashboard.
  TAIL_HELIUS_WEBHOOK_ID: z.string().optional(),

  // ---- Tail live trading -- REAL funds, REAL swaps, no per-trade approval
  // step. Both flags below must be explicitly "true" (mirrors the old main
  // strategy's two-flag live-trading safety pattern) and BOT_PRIVATE_KEY
  // must be set, or tail stays paper-only regardless of these.
  TAIL_LIVE_TRADING: boolFromString,
  TAIL_LIVE_TRADING_CONFIRM: boolFromString,
  // Jupiter swap slippage tolerance for live tail trades, in basis points
  // (100 = 1%). Applies to both entries and exits (including the manual
  // Sell button once a position is live).
  TAIL_LIVE_SLIPPAGE_BPS: z.coerce.number().positive().default(100),
  // If the live wallet's USD balance drops more than this % from its value
  // at the start of the current UTC day, new live buys pause until the next
  // UTC day -- existing open positions still sell normally when detected,
  // this only blocks new entries. Not a per-trade stop-loss.
  TAIL_LIVE_DAILY_LOSS_LIMIT_PCT: z.coerce.number().positive().default(20),
  // Runtime kill switch for the daily loss cap above -- defaults to enabled
  // (unset or anything other than the literal string "false" leaves it on).
  // Set to "false" to stop new live buys from pausing on drawdown; set back
  // to "true" (or unset it) to re-arm. Deliberately a separate flag from
  // TAIL_LIVE_DAILY_LOSS_LIMIT_PCT so "temporarily off" doesn't require
  // remembering/restoring a numeric threshold.
  TAIL_LIVE_DAILY_LOSS_CAP_ENABLED: z
    .string()
    .optional()
    .transform((v) => v?.toLowerCase() !== "false"),
});

export type Env = z.infer<typeof envSchema> & {
  /** True only when both TAIL_LIVE_TRADING and TAIL_LIVE_TRADING_CONFIRM are explicitly "true" AND BOT_PRIVATE_KEY is set. */
  tailLiveTradingEnabled: boolean;
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
  // into placing real transactions. BOT_PRIVATE_KEY is also required --
  // fail fast and loudly here rather than starting "live" with no signer.
  if (data.TAIL_LIVE_TRADING && data.TAIL_LIVE_TRADING_CONFIRM && !data.BOT_PRIVATE_KEY) {
    console.error("TAIL_LIVE_TRADING is enabled but BOT_PRIVATE_KEY is not set -- refusing to start.");
    process.exit(1);
  }
  // Not fail-fast (unlike the BOT_PRIVATE_KEY check above) since this
  // doesn't block startup -- but every single price/OHLCV lookup will 401
  // until this is set (see GECKOTERMINAL_API_KEY's comment above), including
  // ones that silently break live position sizing and paper fills, so this
  // needs to be impossible to miss in the logs.
  if (data.PRICE_PROVIDER === "geckoterminal" && !data.GECKOTERMINAL_API_KEY) {
    console.error(
      "*** WARNING: PRICE_PROVIDER=geckoterminal but GECKOTERMINAL_API_KEY is not set -- " +
        "every price/OHLCV lookup will fail with a 401. Get a free key at coingecko.com/en/api/pricing. ***",
    );
  }
  const tailLiveTradingEnabled = data.TAIL_LIVE_TRADING === true && data.TAIL_LIVE_TRADING_CONFIRM === true;

  return { ...data, tailLiveTradingEnabled };
}

export const env = loadEnv();
