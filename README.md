# Vibes & Fibs

An autonomous Solana trading bot with a strict, evidence-based strategy: a
technical setup narrows down entry *timing*, but **on-chain wallet
confirmation is the required gate that actually fires an entry**
(`src/onchain/entryTrigger.ts`) -- real wallets accumulating real size is the
strongest signal this strategy has, not an optional add-on. A technical
setup with no qualifying on-chain confirmation never opens a position; there
is no technical-only path. Exits are managed with ATR-based stops and a
scaled, structure-trailing take-profit. Ships in **paper trading mode by
default** -- live trading is an explicit, double-gated opt-in.

## Strategy

### Entry -- two required gates

**Conditions 1-6 (technical, `src/signals/technicalTrigger.ts`) narrow WHEN
to look.** All six required, none of them sufficient alone:

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

**Condition 7 (on-chain confluence, REQUIRED) is what actually fires an
entry.** Two ways it can fire, sized differently (see Position sizing below):

- **Tier A** -- >= 2 separate, mutually-unconnected wallets each buying >=
  `minBuyPctOfLiquidity`% and <= `maxBuyPctOfLiquidity`% of current pool
  liquidity, >= `minWalletAgeDays` old with >= `minWalletPriorTrades` prior
  trades, and a clean local reputation (no dump within 24h across their last
  5 observed buys -- starts neutral, builds up from what the bot itself
  observes), all within `confirmationWindowHours`. The mutual-unconnectedness
  check (a heuristic for a direct on-chain transaction between two wallets --
  not full funding-graph analysis) only runs when there are 2+ qualifying
  candidates to compare.
- **Tier B** -- exactly 1 qualifying wallet, but it must clear a *raised* bar
  to compensate for having no independent corroboration: reputation >=
  neutral **and** >= `soloConfirmationMinPriorTrades` prior trades (higher
  than the base `minWalletPriorTrades` every candidate needs).

If neither tier fires, the setup is skipped no matter how clean the technical
picture looks -- logged to `signal_log` with the specific reason either way.

### Position sizing

Risk-based, not a flat dollar amount: `size = (account x riskPct) / (entry -
stop)`, hard-capped at `maxPositionSizePct` of the account regardless of stop
distance. `riskPct` depends on which confluence tier fired the entry --
`riskPctPerTrade` (1% default) for Tier A, the smaller `riskPctPerTradeTierB`
(0.5% default) for Tier B, so a marginal single-wallet setup is sized down
rather than bet the same amount as a well-corroborated one. The tier is
stored on the trade record and shown on the dashboard.

Concurrent open positions are hard-capped at `maxConcurrentPositions` (6
default), checked before every new entry -- the daily/weekly circuit
breakers below only gate *new* entries and wouldn't trip until a meaningful
chunk of loss is already realized across many simultaneously-open positions
in a correlated selloff; this cap bounds that exposure directly.

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
Since on-chain confluence is now a required gate, every trade has at least
one tracked confirming wallet -- this override went from a near-permanent
no-op (only applied to the rare trade that happened to also have on-chain
confluence) to active on every single trade. That's a meaningful risk
reduction versus the technical-only-entry version of this strategy: a
confirming wallet dumping is now always a live signal, not just sometimes.

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
  GeckoTerminal (default) or Birdeye for OHLCV price candles and liquidity.
  See [Price/OHLCV data provider](#priceohlcv-data-provider-birdeye-or-geckoterminal)
  and [Why Helius *and* Birdeye](#why-helius-and-birdeye) below.
- **Storage**: SQLite via `better-sqlite3` (`data/bot.sqlite`, gitignored).
- **Dashboard**: a single Express service serves both the poll loop and a
  web dashboard (`src/dashboard/`) on one process -- one Railway deployment.

```
config/watchlist.yaml       -- tokens + per-token strategy params (edit freely, no code changes)
        |
        v
src/engine/loop.ts           -- planScan splits due tokens into a priority lane
        |                        (open positions + pinned) and a budgeted, spread
        |                        dynamic lane, per poll tick:
        |
        +--> src/signals/technicalTrigger.ts   (Conditions 1-6 -- entry TIMING, not
        |      +--> src/signals/fib.ts              sufficient alone: trend, fib+structural
        |      +--> src/signals/sma.ts               confluence, RSI, volume, close confirmation)
        |      +--> src/signals/atr.ts               (ATR(14), Wilder's smoothing, for the stop)
        |
        +--> src/onchain/walletActivity.ts    (records every observed buy/sell)
        +--> src/onchain/entryTrigger.ts      (Condition 7 -- REQUIRED, Tier A/B --
               +--> src/onchain/walletReputation.ts    candidates -> independent confirmation)
               +--> src/onchain/walletConnectivity.ts  (heuristic, only when 2+ candidates: are two wallets connected?)
        |
        v
src/execution/positionSizing.ts   -- risk-based size (tier-dependent), ATR stop
src/execution/circuitBreakers.ts  -- daily/weekly/consecutive-loss halts (maxConcurrentPositions checked in loop.ts, before circuit breakers even run)
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

- **There is no exchange/bridge/market-maker wallet exclusion list.** This
  used to be a `config/known-wallets.yaml` denylist that shipped permanently
  empty. I could not verify from this sandbox (no live network access)
  whether Helius' or Birdeye's/GeckoTerminal's current free/standard-tier
  endpoints expose a wallet-level labeling API -- rather than guess and
  hand-build a list from memory (the same risk this project avoids
  everywhere: a wrong guess creates false confidence in a safety-relevant
  filter), the check and its config file were removed entirely. A filter
  that looks active but never excludes anything is worse than no filter. If
  you find and verify a real labeling source, `src/onchain/walletReputation.ts`
  is where to reintroduce it.
- **Wallet "connectedness" is a direct-transaction heuristic**, not a full
  funding-graph walk: it catches one wallet directly funding another's gas or
  sending it tokens, not a laundered multi-hop relationship. True graph
  analysis needs far more API budget than a free tier supports. It only runs
  at all when 2+ qualifying candidates exist to compare (Tier A) -- Tier B's
  lone wallet has nothing to check connectivity against.
- **Wallet age is a bounded history lookup**, not a real creation timestamp
  (Solana accounts don't have one) -- a proxy that's accurate enough for a
  ">= N days" filter but isn't exact for very old, very active wallets.
- **Tier B (single-wallet confirmation) is inherently weaker evidence than
  Tier A**, even with its raised bar -- that's exactly why it's sized down
  (`riskPctPerTradeTierB`) rather than blocked outright. If backtesting or
  live results show Tier B trades are net negative after fees, the right
  move is to drop Tier B (set `minConfirmingWallets: 2`) rather than keep it
  for trade volume.

## Configuring the watchlist

Edit `config/watchlist.yaml` -- no code changes needed to add/remove tokens
or retune a token's strategy:

```yaml
tokens:
  - symbol: BONK
    address: DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
    enabled: true

    fibPivotWindow: 2
    goldenPocketZonePct: 4
    swingLookbackHours: 96

    trendSmaPeriod: 15
    chopLookbackPeriods: 15
    chopMaxCrossings: 9

    rsiPeriod: 14
    rsiMidline: 65
    rsiOverboughtCeiling: 85

    volumeAvgPeriod: 15
    volumeConfirmationMultiplier: 1.0

    minBuyPctOfLiquidity: 1.5
    maxBuyPctOfLiquidity: 3
    minWalletAgeDays: 7
    minWalletPriorTrades: 1
    soloConfirmationMinPriorTrades: 3
    confirmationWindowHours: 12
    minConfirmingWallets: 1

    atrPeriod: 14
    stopAtrMultiplier: 1

    extensionRatio1: 1.272
    extensionRatio2: 1.618
    scaleOutPct1: 33
    scaleOutPct2: 33

    timeExitHours: 48
    technicalRefreshIntervalMinutes: 5

risk:
  riskPctPerTrade: 1
  riskPctPerTradeTierB: 0.5
  maxPositionSizePct: 10
  dailyLossLimitPct: 3
  weeklyLossLimitPct: 8
  consecutiveLossLimit: 4
  maxConcurrentPositions: 6
```

### Revision history and rationale

The technical thresholds (Conditions 1-6) were loosened twice early on,
both times because the tighter starting values essentially never fired on
BONK/WIF in practice:

| param | original | loosened once | current |
|---|---|---|---|
| `trendSmaPeriod` | 50 | 20 | 15 |
| `goldenPocketZonePct` | 1% | 2.5% | 4% |
| `chopMaxCrossings` | 3 | 6 | 9 |
| `rsiMidline` | 50 | 60 | 65 |
| `rsiOverboughtCeiling` | n/a | 78 | 85 |
| `volumeConfirmationMultiplier` | n/a | 1.2x | 1.0x (no spike required) |
| `fibPivotWindow` | n/a | 3 | 2 |

At these settings, Conditions 1-6 are about as permissive as they can be
without removing them outright -- this was deliberately left unchanged in
the on-chain-gate revision below, since low trade frequency traced back to
the scan cadence and the on-chain gate's own thresholds, not these.

**The bigger revision**: on-chain confluence went from optional/non-blocking
confluence to a **required** entry gate (restoring the strategy's original
premise that on-chain evidence is the strongest signal, technical is a
timing filter), while its own thresholds were loosened in the same change
since they'd never been exercised as a hard gate before:

| param | before (optional confluence) | now (required gate) |
|---|---|---|
| `confirmationWindowHours` | 4 | 12 -- real accumulation rarely clusters into a tight burst |
| buy-size filter | flat `minBuyUsd: $5,000` | `minBuyPctOfLiquidity: 1.5%` -- a flat $ bar is trivial on a $5M pool, unreachable on a $60k one |
| `minWalletAgeDays` | 14 | 7 -- still excludes freshly-funded bundler-pattern wallets |
| `minConfirmingWallets` | 2 (hard requirement) | 1, via the Tier A/B split below |

Instead of one pass/fail bar, confirmation now has two tiers (see
[Position sizing](#position-sizing)) so the bot can take a marginal,
single-wallet setup without betting the same amount on it as a
well-corroborated one: **Tier A** keeps the original >=2-mutually-unconnected
requirement at full size; **Tier B** allows exactly 1 wallet but only if it
clears a raised bar (`soloConfirmationMinPriorTrades: 3`, neutral-or-better
reputation) and is sized down to `riskPctPerTradeTierB`.

If a trade still doesn't fire within a few days at these settings, check
`signal_log`'s `detail` column for the specific condition that's failing
(technical or on-chain) before loosening further -- and check the
"watchlist cadence" log line (`engine/loop.ts`) to confirm the dynamic
watchlist is actually being scanned close to once per candle period, not
silently falling behind, since that was the single biggest driver of low
trade frequency before this revision, not the evidence thresholds.

`scaleOutPct1 + scaleOutPct2` must leave a remainder for the runner, and
`extensionRatio2` must exceed `extensionRatio1` (both validated at load
time). `risk` applies globally across all tokens.

### Dynamic watchlist: trading the top N most-traded tokens

Instead of (or alongside) hand-picking tokens, `watchlistSource.mode:
top_traded` trades the top `topTradedCount` tokens by 24h volume on Solana,
re-selected every `refreshIntervalHours`, each using the shared
`defaultStrategy` block (individually hand-tuning 100 tokens isn't
realistic). The `tokens` list still rides along as an always-included pin
list on top of the dynamic selection -- BONK/WIF stay pinned with their own
params in the shipped config even with `top_traded` enabled.

```yaml
watchlistSource:
  mode: top_traded
  topTradedCount: 100
  refreshIntervalHours: 24
  minLiquidityUsd: 50000
  minTokenAgeHours: 24 # excludes pools younger than this -- the most manipulable, least statistically meaningful class of token

defaultStrategy:
  # same fields as a token entry, minus symbol/address/enabled
  ...
  technicalRefreshIntervalMinutes: 15
```

A failed refresh (provider down, rate-limited, etc.) falls back to the last
successful selection rather than leaving the bot with zero tokens.

**Scan cadence has to match the candle interval, not just fit a budget.**
Condition 6 (confirmed close) is a per-candle event -- the dynamic tokens use
15-minute candles, so `technicalRefreshIntervalMinutes: 15` is what it takes
to actually catch most valid setups instead of silently missing the large
majority of them by scanning less often than one candle period. The earlier
version of this bot set it to 240 (4h) specifically to fit Birdeye's monthly
call quota; that reasoning doesn't carry over to GeckoTerminal (the default
provider), which has no monthly quota, just a per-minute rate limit -- so the
real question became "can 100 tokens be scanned every 15 minutes without
bursting past that per-minute limit," not "how rarely can we get away with
scanning."

**The answer is yes, but not by scanning the due batch as fast as
possible.** `engine/loop.ts`'s `planScan` splits each cycle into two lanes:

- **Priority lane** -- open positions (always managed every cycle; stop/
  trailing tracking must stay current) plus due pinned tokens (2 by default,
  trivial cost). Processed promptly with a small fixed gap
  (`TOKEN_STAGGER_MS`, 2s).
- **Dynamic lane** -- due tokens from the top-N watchlist, budgeted to
  `ceil(topTradedCount / ticksPerWindow)` per poll tick (with
  `POLL_INTERVAL_SECONDS: 60` and a 15-minute window, that's `ceil(100/15) =
  7` tokens/tick) and sorted oldest-evaluated-first so any backlog
  self-heals. Instead of a fixed gap, this lane's stagger is computed to
  spread across ~80% of the tick's full duration -- turning "scan all 100
  the moment they're due" (a burst hitting ~30 calls/min, the rate-limit
  ceiling) into "scan ~7 tokens spread across each 60-second tick" (a
  steady ~7-8 calls/min, about a quarter of the ceiling).

Verified against the actual implementation, not just estimated: with the
shipped defaults (100 dynamic tokens at 15min + 2 pinned at 5min), this
comes out to **~11,100 provider calls/day, ~7.7/min sustained** -- logged at
startup (`estimated price-provider usage`) and reconcilable against
GeckoTerminal's ~30/min free-tier limit (higher with `GECKOTERMINAL_API_KEY`)
or Birdeye's monthly quota if `PRICE_PROVIDER=birdeye`. Every cycle also logs
a **watchlist cadence** line -- due/budgeted dynamic token counts and the
oldest dynamic token's actual staleness versus the `technicalRefreshIntervalMinutes`
target, flagged `FALLING BEHIND` if it's slipping -- so whether the whole
watchlist is really being sampled every candle (not just assumed to be) is
directly visible in the logs, not something you have to take on faith.

Lazy liquidity lookups and the open-positions-skip-candles-until-runner-active
optimization (both described in earlier revisions of this doc) are still in
place and unaffected by the cadence change above -- liquidity is now fetched
lazily for both its original purpose (the on-chain confluence size check)
*and* the entry-time re-check (see Priority 3 in the changelog), one fetch
serving both.

## Logging & visibility

Every entry evaluation is written to `signal_log` -- including the ones that
don't lead to a trade -- with whether the technical trigger (Conditions 1-6)
passed, whether on-chain confluence (Condition 7) fired, and a detail blob
(which condition failed, skip reason, confirming wallets, confluence tier).
Every trade records its confirming wallets and their reputation at entry
(`trade_signal_wallets` -- never empty now that on-chain confluence is
required) and which tier fired it (`trades.confluence_tier`), and every
partial exit is its own row in `position_exits` (tranche, price, reason,
P&L), so a closed trade's full lifecycle -- entry context, each scale-out,
final close -- is reconstructable from the DB, not just a single row's
summary. The dashboard's Signal History and per-position cards are a
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

**Don't, until you've run a backtest.** This strategy has never been
validated against historical data -- a few days of paper trading with few or
zero fills tells you nothing about whether it has an edge. See
[Backtesting before live capital](#backtesting-before-live-capital) below
for the harness and what it can and can't currently validate. If the
backtest doesn't beat a buy-and-hold baseline net of realistic fees and
slippage, that's a real answer, not a reason to keep tuning parameters until
it does -- overfitting to history is the most likely way this ends up
losing money live while looking great in testing.

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

## Backtesting before live capital

`npm run backtest -- --days 90 [--tokens addr1,addr2] [--top 100] [--fee-bps 30] [--slippage-bps 100]`
(`src/backtest/run.ts`) walk-forward replays historical OHLCV candles
through the exact same pure functions the live bot uses --
`evaluateTechnicalTrigger`, `computeATR`/`computeInitialStop`,
`computeFibExtensions`, `decideExitAction` -- fee- and slippage-adjusted, and
reports trade count, win rate, avg win/loss, net return, max drawdown, and a
buy-and-hold comparison over the same window. Defaults to the pinned tokens
in `config/watchlist.yaml` if neither `--tokens` nor `--top` is given.
`--top N` fetches the *current* top-N-by-volume tokens live from
`PRICE_PROVIDER` and backtests those too -- note this applies today's
top-N selection uniformly across the whole lookback window rather than
replaying how the dynamic watchlist's composition actually rotated day by
day historically, so treat it as "how would the strategy do on today's hot
tokens, over the recent past" rather than a faithful historical replay.

**Read this before trusting a single number it prints.** The backtest
simulates **Conditions 1-6 (technical) only.** Condition 7 (on-chain
confluence) is a **required** gate in the live/paper bot -- a technical
setup with no qualifying wallet confirmation never opens a position -- and
it is **not simulated** here. Reproducing it historically would mean
per-wallet buy/sell data at the exact historical moments being tested, plus
that wallet's reputation *as of that moment* (using its current reputation
would be look-ahead bias) -- data this sandbox has no way to fetch and that
would be expensive to gather even with live access (Helius per-wallet
history lookups, at volume, across months). Concretely, that means:

- Every backtest trade assumes Condition 7 would *also* have fired. Real
  trade frequency will be lower than these numbers suggest, likely
  substantially -- most technical setups never get on-chain confirmation.
- There is no Tier A/Tier B split in this output, because there's no
  simulated confirmation to derive a tier from -- every backtest trade is
  sized at the base `riskPctPerTrade`, not the tier-dependent sizing the
  live bot actually uses.
- This is a diagnostic on whether the *technical* filter identifies
  favorable entry timing, not a validation of the deployed strategy's
  actual expected performance.

The practical way to validate the FULL strategy, Condition 7 included, is
**forward paper-trading** -- paper mode runs the exact same code path as
live (just simulated fills), so its trade set, tiers, and P&L are the real
ones, accumulating going forward rather than reconstructed from history. Run
paper mode for a meaningful stretch and treat that data -- not this
backtest -- as the actual pre-live validation. If you build out historical
wallet-data collection later, `src/backtest/engine.ts`'s `runBacktest` is
structured so a real `onchainFired`/`tier` signal could be threaded in
alongside the technical check without needing to rewrite the simulation
loop.

This sandbox has no live network access, so every run attempted while
building this returned a network error -- the harness has not been run
against real data. Run it yourself somewhere with real network access
(locally, or a Railway shell) and read the printed numbers with the caveats
above in mind. If it doesn't beat buy-and-hold net of fees, that's a real
answer -- don't tune parameters until it does; overfitting to history is the
likeliest way this ends up losing money live while looking great in testing.

## Development

```bash
npm run dev             # tsx watch mode
npm run typecheck
npm test                 # node:test -- pure-logic unit tests (fib/ATR math, sizing, exit decisions)
npm run evaluate          # runs one full poll cycle immediately and exits, without
                           # waiting for POLL_INTERVAL_SECONDS -- useful for
                           # sanity-checking live provider/Helius responses
npm run backtest          # walk-forward technical-only backtest -- see
                           # "Backtesting before live capital" above for what
                           # it does and doesn't validate
npm run generate-keypair  # creates the bot's own Solana keypair (run yourself, see above)
```

## Deployment (Railway)

`railway.json` is checked in (Nixpacks build, `npm start`, health check on
`/api/status`). Set the env vars from `.env.example` in the Railway project's
variables, including `BOT_PRIVATE_KEY` only once you're ready to go live --
leave it unset to run in paper mode indefinitely.
