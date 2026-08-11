# Vibes & Fibs

An autonomous Solana trading bot with a strict, structure-based strategy: a
**technical setup is the entry gate on its own** -- it does not need a big
wallet buying alongside it -- and **on-chain wallet confirmation is optional
confluence**, logged against a trade and folded into its reason when it
happens to coincide, but never required and never blocking when it's absent.
Exits are managed with ATR-based stops and a scaled, structure-trailing
take-profit. Ships in **paper trading mode by default** -- live trading is an
explicit, double-gated opt-in.

## Strategy

### Entry (all technical conditions required; on-chain confluence is optional)

**The technical trigger (`src/signals/technicalTrigger.ts`) is the entry
gate**, and it fires on its own -- no wallet activity required:

1. **Trend context** -- price above the `trendSmaPeriod` SMA (don't fight the
   trend), and not choppy (fewer than `chopMaxCrossings` MA crossings in the
   last `chopLookbackPeriods` candles -- fib/momentum setups both underperform
   in a ranging market).
2. **Fib zone + structural confluence** -- price within `goldenPocketZonePct`%
   of the 0.5 or 0.618 retracement off the most recent *confirmed* swing (a
   pivot needs `fibPivotWindow` candles flanking it on both sides before it
   counts, not still-forming price action), **and** that level sits within
   the same tolerance of a genuine prior pivot -- a fib ratio alone is weak,
   fib stacked on an actual prior reaction level is a materially better setup.
3. **Momentum confirmation** -- RSI(`rsiPeriod`) turning up from below
   `rsiMidline` while price is in the zone (confirms momentum shifting back,
   not just drifting through the level), and not already past
   `rsiOverboughtCeiling` (catching a pullback, not chasing).
4. **Volume confirmation** -- the reaction candle clears
   `volumeConfirmationMultiplier`x the `volumeAvgPeriod`-period average. A
   low-volume bounce is much more likely to fail.
5. **Candle close confirmation** -- a full close back above the zone, not
   just an intra-candle wick. Entering on the wick is how a level that gets
   swept and reversed fakes you out.

A confirmed downtrend is a hard no regardless of the above: this is a
long-only bot, so it doesn't chase bounces in a structure that's still falling.

**On-chain wallet confirmation is evaluated independently as confluence, not
a gate** (`src/onchain/entryTrigger.ts`): >= `minConfirmingWallets` separate,
mutually-unconnected wallets each buying >= `minBuyUsd` and <=
`maxBuyPctOfLiquidity`% of pool liquidity, >= `minWalletAgeDays` old with
prior history, untagged, and with a clean local reputation (no dump within
24h across their last 5 observed buys -- starts neutral, builds up from what
the bot itself observes). When this coincides with a fired technical trigger,
it's recorded against the trade (`trade_signal_wallets`) and noted in the
trade's reason; when it's absent, or the Helius lookup itself fails, the
technical trigger still fires the trade on its own.

### Position sizing

Risk-based, not a flat dollar amount: `size = (account x riskPctPerTrade) /
(entry - stop)`, hard-capped at `maxPositionSizePct` of the account regardless
of stop distance. No cap on concurrent open positions.

### Stop loss

`swing low - (stopAtrMultiplier x ATR(atrPeriod))`, using Wilder's smoothing
(not a plain moving average) recalculated fresh every cycle -- volatility
regimes shift fast, a static ATR value goes stale.

### Take profit -- scaled, runner uncapped

- `scaleOutPct1`% closed at the `extensionRatio1` (1.272) fib extension
- `scaleOutPct2`% closed at the `extensionRatio2` (1.618) fib extension
- The remainder rides with no fixed target: once 1.618 clears, the stop moves
  to breakeven, then trails below each new confirmed higher pivot low as
  price makes new highs -- structure-based, not a fixed percent. It stays
  open as long as trend structure holds.

### Time exit

Applies only to the unscaled portion: if `timeExitHours` passes without
hitting the stop or the first scale-out target, the whole position closes.
Once the first scale-out has fired, the clock no longer matters -- the
trade's proven itself and the runner is never time-limited.

### Signal reversal override

If any of *this trade's own confirming wallets* sells the token, that's an
immediate full close, regardless of where price sits relative to stop/targets.

### Account-level circuit breakers

- **Daily**: `dailyLossLimitPct`% drawdown halts new entries for the rest of
  the UTC day (existing positions keep being managed for exit) -- clears
  itself automatically at midnight UTC, no persisted state needed.
- **Weekly**: `weeklyLossLimitPct`% drawdown (trailing 7 days) halts entirely
  and stays halted until a human resumes it from the dashboard.
- **Consecutive losses**: `consecutiveLossLimit` losses in a row halts
  entirely, same sticky no-auto-resume behavior.

A halt only blocks *new* entries -- abandoning risk management on positions
already open, just because new risk is paused, would be the wrong kind of
"safety."

## Architecture at a glance

- **Runtime**: Node.js + TypeScript, run directly via `tsx` (no build step in
  production).
- **Execution**: the bot holds its **own** Solana keypair, loaded from an env
  var and funded manually by sending SOL from your Phantom wallet. Phantom is
  a browser extension and can't run headless, so it's never involved at
  runtime -- the bot signs and sends its own transactions via
  [`@solana/web3.js`](https://github.com/anza-xyz/solana-web3.js) and the
  [Jupiter Swap API](https://dev.jup.ag/docs/swap-api/).
- **Data**: [Helius](https://helius.dev) for RPC + wallet activity/reputation,
  [Birdeye](https://birdeye.so) for OHLCV price candles and liquidity. See
  [Why Helius *and* Birdeye](#why-helius-and-birdeye) below.
- **Storage**: SQLite via `better-sqlite3` (`data/bot.sqlite`, gitignored).
- **Dashboard**: a single Express service serves both the poll loop and a
  web dashboard (`src/dashboard/`) on one process -- one Railway deployment.

```
config/watchlist.yaml       -- tokens + per-token strategy params (edit freely, no code changes)
config/known-wallets.yaml   -- exchange/bridge/market-maker denylist (user-maintained, ships empty)
        |
        v
src/engine/loop.ts           -- polls on an interval, per enabled token:
        |
        +--> src/signals/technicalTrigger.ts   (the entry gate -- trend, fib+structural
        |      +--> src/signals/fib.ts              confluence, RSI, volume, close confirmation)
        |      +--> src/signals/sma.ts
        |      +--> src/signals/rsi.ts
        |      +--> src/signals/atr.ts               (ATR(14), Wilder's smoothing, for the stop)
        |
        +--> src/onchain/walletActivity.ts    (records every observed buy/sell)
        +--> src/onchain/entryTrigger.ts      (OPTIONAL confluence, never blocking --
               +--> src/onchain/walletReputation.ts    candidates -> independent confirmation)
               +--> src/onchain/walletConnectivity.ts  (heuristic: are two wallets connected?)
        |
        v
src/execution/positionSizing.ts   -- risk-based size, ATR stop
src/execution/circuitBreakers.ts  -- daily/weekly/consecutive-loss halts
src/execution/exitManager.ts      -- signal reversal, stop, scale-outs, trailing, time exit (pure decision)
        |
        +--> paper mode: src/execution/paperTrading.ts  (simulated fills)
        +--> live mode:  src/execution/liveTrading.ts   (real Jupiter swaps, incl. partial scale-outs)
```

## Setup

```bash
npm install
cp .env.example .env   # fill in the values below
npm run typecheck
npm test
npm start              # runs the poll loop + dashboard together
```

The dashboard is served on `DASHBOARD_PORT` (default `4000`; Railway's
injected `PORT` takes priority automatically). Open it in a browser to see
open positions (with live scale-out progress), trade history, and the full
signal log.

## Required API keys / env vars

| Var | Required for | Where to get it |
|---|---|---|
| `HELIUS_API_KEY` | RPC (also doubles as the default `SOLANA_RPC_URL`) + wallet activity/reputation lookups | [helius.dev](https://helius.dev) -- free tier is enough for one bot |
| `BIRDEYE_API_KEY` | OHLCV candles (fib/ATR), liquidity data -- only if `PRICE_PROVIDER=birdeye` | [birdeye.so/find-more](https://birdeye.so/find-more) -- free Standard tier |
| `GECKOTERMINAL_API_KEY` | Optional but strongly recommended if `PRICE_PROVIDER=geckoterminal` (the default) | [coingecko.com/en/api/pricing](https://www.coingecko.com/en/api/pricing) -- the free "Demo" tier, not a paid plan |
| `BOT_PRIVATE_KEY` | Live trading only | Run `npm run generate-keypair` yourself -- see [Live trading](#flipping-paper--live) |

Everything else in `.env.example` has a sane default (poll interval, paper
starting balance, dashboard port, DB path, watchlist config path).

### Price/OHLCV data provider: Birdeye or GeckoTerminal

`PRICE_PROVIDER` picks which service serves OHLCV candles, current price,
and the top-traded token list (`src/data/priceProvider.ts` is the single
switch point -- every other module imports through it, never a specific
provider directly):

- **`birdeye`** -- the more thoroughly exercised option, but needs
  `BIRDEYE_API_KEY` and a metered plan (the free Standard tier has a
  monthly call cap -- see the budget math in
  [Configuring the watchlist](#dynamic-watchlist-trading-the-top-n-most-traded-tokens)).
  Once that cap is hit, Birdeye stops serving requests for the rest of the
  billing period.
- **`geckoterminal`** (default) -- GeckoTerminal's public API. Works with
  zero setup so a fresh deploy runs immediately even with Birdeye's quota
  exhausted, but **set `GECKOTERMINAL_API_KEY` to a free CoinGecko "Demo"
  key** the first chance you get: a fully anonymous request shares its rate
  limit with every other unauthenticated caller hitting GeckoTerminal
  worldwide, not just this bot, which is a much worse ceiling in practice
  than a per-key allowance. The Demo key is free (no card, no paid plan --
  don't confuse it with the "Pro"/"Analyst" tiers the 429 error message
  itself points at), sent via the `x-cg-demo-api-key` header. Even with a
  key, this provider has a couple of other tradeoffs vs. Birdeye: its
  OHLCV endpoint is scoped to a liquidity pool rather than a token mint
  directly -- `src/data/geckoterminal.ts` resolves and caches each token's
  primary pool (by reserve size) the first time it's seen (`token_pool_cache`
  table), so that's a one-time cost per token, not a per-cycle one -- and
  the field shapes for `getTopTradedTokens` in particular (derived from
  GeckoTerminal's top-pools listing, since it has no direct "top tokens"
  endpoint) are my best-effort mapping and, like every provider integration
  in this project, unverified from a sandbox with no live network access --
  check the raw error message on first run if it comes back empty rather
  than assuming the strategy logic is at fault. A 429 that survives the
  built-in retry/backoff isn't fatal either way: engine/loop.ts logs it to
  `signal_log` and that token is simply picked up again next cycle.

Switching providers is a one-line env change (`PRICE_PROVIDER=birdeye` or
`geckoterminal`) and a redeploy -- no code changes, and `token_pool_cache`
sitting unused when on Birdeye is harmless. `TOKEN_STAGGER_MS`
(`src/engine/loop.ts`) is tuned for GeckoTerminal's tighter limit since
that's the default; both providers retry with backoff on a 429 as a
backstop for bursts that still exceed it.

### Why Helius *and* Birdeye

- **Birdeye** is the natural fit for OHLCV candles (fib/ATR) and liquidity
  data -- that's its core product, free tier covers it directly.
- **Helius** is the better fit for wallet activity (its Enhanced Transactions
  API returns already-decoded swap data for any address -- a token mint's
  history for confirmation candidates, or a wallet's own history for age/tag
  checks) and is needed regardless as the RPC endpoint for live swaps.

If you only set `HELIUS_API_KEY` and leave `SOLANA_RPC_URL` at its default,
the bot automatically uses Helius's RPC instead of the public one.

### Known limitations in the on-chain confluence check (flagged, not hidden)

- **`config/known-wallets.yaml` ships empty.** There's no reliable free API
  that labels Solana wallets as exchange/bridge/market-maker, and hot wallets
  rotate over time -- a wrong guessed address would give false confidence in
  a safety-relevant filter, which is worse than no list at all. Populate it
  yourself from a source you trust (Solscan's labels, your own observation).
- **Wallet "connectedness" is a direct-transaction heuristic**, not a full
  funding-graph walk: it catches one wallet directly funding another's gas or
  sending it tokens, not a laundered multi-hop relationship. True graph
  analysis needs far more API budget than a free tier supports.
- **Wallet age is a bounded history lookup**, not a real creation timestamp
  (Solana accounts don't have one) -- a proxy that's accurate enough for a
  ">= N days" filter but isn't exact for very old, very active wallets.

## Configuring the watchlist

Edit `config/watchlist.yaml` -- no code changes needed to add/remove tokens
or retune a token's strategy:

```yaml
tokens:
  - symbol: BONK
    address: DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
    enabled: true

    fibPivotWindow: 3
    goldenPocketZonePct: 2.5
    swingLookbackHours: 96

    trendSmaPeriod: 20
    chopLookbackPeriods: 15
    chopMaxCrossings: 6

    rsiPeriod: 14
    rsiMidline: 60
    rsiOverboughtCeiling: 78

    volumeAvgPeriod: 15
    volumeConfirmationMultiplier: 1.2

    minBuyUsd: 5000
    maxBuyPctOfLiquidity: 3
    minWalletAgeDays: 14
    minWalletPriorTrades: 1
    confirmationWindowHours: 4
    minConfirmingWallets: 2

    atrPeriod: 14
    stopAtrMultiplier: 1

    extensionRatio1: 1.272
    extensionRatio2: 1.618
    scaleOutPct1: 33
    scaleOutPct2: 33

    timeExitHours: 48

risk:
  riskPctPerTrade: 1
  maxPositionSizePct: 10
  dailyLossLimitPct: 3
  weeklyLossLimitPct: 8
  consecutiveLossLimit: 4
```

These defaults have been loosened twice now, both times because the tighter
values essentially never fired on BONK/WIF in practice:

| param | original | loosened once | current |
|---|---|---|---|
| `trendSmaPeriod` | 50 | 20 | 15 |
| `goldenPocketZonePct` | 1% | 2.5% | 4% |
| `chopMaxCrossings` | 3 | 6 | 9 |
| `rsiMidline` | 50 | 60 | 65 |
| `rsiOverboughtCeiling` | n/a | 78 | 85 |
| `volumeConfirmationMultiplier` | n/a | 1.2x | 1.0x (no spike required) |
| `fibPivotWindow` | n/a | 3 | 2 |

At the current settings, every condition is about as permissive as it can be
without removing it outright: a 15-period SMA on hourly candles is a
~15-hour lookback, the golden pocket zone is 8x wider than a standard 0.5%
target, up to 9 MA crossings in 15 candles is close to pure chop, RSI just
needs to be turning up anywhere below 65, and the reaction candle no longer
needs above-average volume at all. If a trade still doesn't fire within a
few days at these settings, the bottleneck is more likely the underlying
data (a Birdeye field not populating as expected, `swingLookbackHours` not
returning enough candles for the chosen `pickOhlcvInterval`, etc.) than the
threshold values themselves -- check `signal_log`'s `detail` column for the
specific condition that's failing before loosening further, since past this
point the technical trigger stops meaningfully filtering for a real setup at
all.

`scaleOutPct1 + scaleOutPct2` must leave a remainder for the runner, and
`extensionRatio2` must exceed `extensionRatio1` (both validated at load
time). `risk` applies globally across all tokens.

### Dynamic watchlist: trading the top N most-traded tokens

Instead of (or alongside) hand-picking tokens, `watchlistSource.mode:
top_traded` trades the top `topTradedCount` tokens by 24h volume on Solana,
re-selected from Birdeye's tokenlist every `refreshIntervalHours`, each using
the shared `defaultStrategy` block (individually hand-tuning 100 tokens
isn't realistic). The `tokens` list still rides along as an always-included
pin list on top of the dynamic selection -- BONK/WIF stay pinned with their
own params in the shipped config even with `top_traded` enabled.

```yaml
watchlistSource:
  mode: top_traded
  topTradedCount: 100
  refreshIntervalHours: 24
  minLiquidityUsd: 50000

defaultStrategy:
  # same fields as a token entry, minus symbol/address/enabled
  ...
  technicalRefreshIntervalMinutes: 240
```

A failed refresh (Birdeye down, rate-limited, etc.) falls back to the last
successful selection rather than leaving the bot with zero tokens.

**Keeping this within a free-tier Birdeye budget (e.g. 30k calls/month).**
The technical trigger needs a fresh OHLCV fetch per token to evaluate fib/
RSI/volume/close conditions -- that's the unavoidable cost of running 100
tokens through a real technical strategy, and it doesn't shrink just because
current price got cheaper to fetch. What *does* shrink it:

- **Batched pricing.** Current price (needed for wallet-activity sizing,
  position management, and the entry check itself) is fetched for the whole
  due-batch in one Birdeye `multi_price` call instead of one
  `token_overview` call per token per cycle.
- **Per-token throttling, decoupled from poll interval.** Each token only
  gets a fresh OHLCV fetch + technical re-evaluation once every
  `technicalRefreshIntervalMinutes` (240 = 4h by default for the dynamic
  100), tracked per-token in the DB (`watchlist_tokens.last_technical_eval_at`)
  -- not once per poll cycle. `POLL_INTERVAL_SECONDS` just controls how often
  the bot *checks whether anything is due*, which is cheap; it no longer
  determines how often 100 tokens actually get scanned. A token with an open
  position is always managed every poll cycle regardless (stop/trailing
  tracking needs to stay current) -- that cost scales with how many
  positions are open, not watchlist size.
- **Lazy liquidity lookups.** The optional on-chain-confluence check needs
  pool liquidity, but only for tokens whose technical trigger already fired
  that cycle -- so `token_overview` (for liquidity) is only called on an
  actual signal, not for the whole watchlist every cycle.
- **Open positions only fetch candles once the runner is active.** Stop-loss,
  scale-out targets, and the time exit are all plain price comparisons --
  `decideExitAction` only reads OHLCV history for the runner's
  structure-trailing stop, which only exists after both scale-outs have
  fired. An open position that hasn't reached that stage yet costs zero
  extra Birdeye calls beyond the batched price it already gets as part of
  the due-token price fetch.

With the shipped defaults (100 dynamic tokens at a 4h technical-scan
interval + 2 pinned tokens at 1h), that's roughly **~21k Birdeye calls/month**
baseline -- comfortably under a 30k/month cap. If your real usage (check
Birdeye's own dashboard after a day or two) comes in under budget, tighten
`technicalRefreshIntervalMinutes` for faster reaction to new setups; if it's
over, loosen it or lower `topTradedCount`. The remaining variable is the
uncapped concurrent-position limit (see below): a period with many
simultaneous *runner-active* positions (already through both scale-outs, so
still trailing a live stop) will push usage above this baseline, at one
OHLCV call per poll cycle per such position for as long as it stays in that
state.

## Logging & visibility

Every entry evaluation is written to `signal_log` -- including the ones that
don't lead to a trade -- with whether the technical trigger passed, whether
on-chain confluence happened to be present, and a detail blob (which
technical condition failed, skip reason, confirming wallets if any). Every
trade records its confirming wallets and their reputation at entry
(`trade_signal_wallets`, empty when the trade fired on technicals alone), and
every partial exit is its own row in `position_exits` (tranche, price,
reason, P&L), so a closed trade's full lifecycle -- entry context, each
scale-out, final close -- is reconstructable from the DB, not just a single
row's summary. The dashboard's Signal History and per-position cards are a
live view of all of this.

## Running a multi-day paper trial and keeping the data

SQLite is more than sufficient for this at any reasonable scale (weeks or
months of signal/trade history) -- **you don't need Postgres.** The real risk
to a multi-day run isn't the database engine, it's that **Railway's container
filesystem is ephemeral by default**: every redeploy (including one to tweak
the strategy mid-run) spins up a fresh container, and `data/bot.sqlite` goes
with it unless it's on persistent storage. Before starting a run you care
about:

1. In the Railway dashboard, add a **Volume** to the service, mounted at
   e.g. `/data`.
2. Set `DATABASE_PATH=/data/bot.sqlite` in the service's env vars.
3. Redeploy once with that in place.

After that, the SQLite file survives redeploys independently of the app
container -- tweak the watchlist config or strategy code and push freely
without losing history. To analyze afterward, pull the file down (`railway
ssh` or a one-off script reading `/data/bot.sqlite`) and query it directly,
or use `npm run evaluate` / the dashboard's API endpoints (`/api/signals`,
`/api/trades`) as a lighter-weight read path than pulling the whole DB.

## Flipping paper -> live

Live trading requires all of the following, on purpose -- there's no single
switch:

1. **Fund the bot's own wallet.** Run `npm run generate-keypair` **yourself**
   (locally, or in a Railway shell) -- it prints a public address to fund from
   Phantom and a base58 secret. Run it yourself rather than asking anyone else
   to, since the secret it prints should never appear in a chat log or
   anywhere outside your own env vars.
2. Put that secret in `BOT_PRIVATE_KEY`.
3. Send SOL to the printed public address from Phantom. This is the bot's
   entire live risk capital -- size it deliberately.
4. Set **both** `LIVE_TRADING=true` and `LIVE_TRADING_CONFIRM=true`. Both are
   required; either one alone leaves the bot in paper mode.
5. Restart the bot. On startup it logs the wallet's public address and
   current SOL balance so you can visually confirm it's the right wallet and
   it's actually funded -- if `BOT_PRIVATE_KEY` is missing/invalid, or the
   RPC call fails, it refuses to start rather than silently falling back to
   paper mode under a misleading label.

To go back to paper mode, set `LIVE_TRADING=false` (or drop
`LIVE_TRADING_CONFIRM`) and restart. Nothing about the watchlist config or
risk settings needs to change -- the same strategy config drives both modes.

**Live mode swaps against SOL**, not USDC: buys are SOL -> token, scale-outs
and the final close sell a computed fraction of the wallet's *actual*
on-chain balance back to SOL, via Jupiter's free `lite-api.jup.ag` tier.
Quantities are always read back from the chain (not a swap quote's estimate),
so they stay correct regardless of slippage or partial-exit drift.

## Development

```bash
npm run dev             # tsx watch mode
npm run typecheck
npm test                 # node:test -- pure-logic unit tests (fib/ATR math, sizing, exit decisions)
npm run evaluate          # runs one full poll cycle immediately and exits, without
                           # waiting for POLL_INTERVAL_SECONDS -- useful for
                           # sanity-checking live Birdeye/Helius responses
npm run generate-keypair  # creates the bot's own Solana keypair (run yourself, see above)
```

## Deployment (Railway)

`railway.json` is checked in (Nixpacks build, `npm start`, health check on
`/api/status`). Set the env vars from `.env.example` in the Railway project's
variables, including `BOT_PRIVATE_KEY` only once you're ready to go live --
leave it unset to run in paper mode indefinitely.
