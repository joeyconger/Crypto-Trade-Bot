# Vibes & Fibs

An autonomous Solana trading bot that combines a technical signal (fibonacci
retracement + support/resistance confluence), an on-chain signal (whale moves,
volume/liquidity spikes), and a social signal (currently disabled -- see
[Social signal](#social-signal-disabled-in-v1) below) into one weighted score
per watchlist token, then acts on it. Ships in **paper trading mode by
default** -- live trading is an explicit, double-gated opt-in.

## Architecture at a glance

- **Runtime**: Node.js + TypeScript, run directly via `tsx` (no build step in
  production).
- **Execution**: the bot holds its **own** Solana keypair, loaded from an env
  var and funded manually by sending SOL from your Phantom wallet. Phantom is
  a browser extension and can't run headless, so it's never involved at
  runtime -- the bot signs and sends its own transactions via
  [`@solana/web3.js`](https://github.com/anza-xyz/solana-web3.js) and the
  [Jupiter Swap API](https://dev.jup.ag/docs/swap-api/).
- **Data**: [Helius](https://helius.dev) for RPC + whale wallet transaction
  monitoring, [Birdeye](https://birdeye.so) for OHLCV price candles and
  liquidity/volume data. See [Why Helius *and* Birdeye](#why-helius-and-birdeye)
  below.
- **Storage**: SQLite via `better-sqlite3` (`data/bot.sqlite`, gitignored) --
  watchlist registry, trade history, and a full signal-evaluation audit log
  (every cycle, whether or not it traded).
- **Dashboard**: a single Express service serves both the poll loop and a
  web dashboard (`src/dashboard/`) on one process -- one Railway deployment.

```
config/watchlist.yaml  -- tokens + per-token strategy params (edit freely, no code changes)
        |
        v
src/engine/loop.ts      -- polls on an interval, evaluates every enabled token
        |
        +--> src/signals/technical.ts  (Birdeye OHLCV -> fib levels -> score)
        +--> src/signals/onchain.ts    (Helius whale txs + Birdeye volume/liquidity -> score)
        +--> src/signals/social.ts     (stub, always 0 -- see below)
        |
        v
src/engine/scoring.ts   -- weights the three into combined_score, logs every
        |                  evaluation to signal_log regardless of outcome
        v
src/execution/risk.ts   -- position size cap, max concurrent, daily loss halt
        |
        +--> paper mode: src/execution/paperTrading.ts  (simulated fill)
        +--> live mode:  src/execution/liveTrading.ts   (real Jupiter swap)
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
open positions, trade history, and the full signal log.

## Required API keys / env vars

Ask for each of these as you set the project up -- nothing runs against a
silently-stubbed data source.

| Var | Required for | Where to get it |
|---|---|---|
| `HELIUS_API_KEY` | RPC (also doubles as the default `SOLANA_RPC_URL` if you don't set one explicitly) + whale-move detection | [helius.dev](https://helius.dev) -- free tier is enough for one bot |
| `BIRDEYE_API_KEY` | OHLCV candles (fib calc), volume/liquidity data | [birdeye.so/find-more](https://birdeye.so/find-more) -- free Standard tier |
| `BOT_PRIVATE_KEY` | Live trading only | Run `npm run generate-keypair` yourself -- see [Live trading](#flipping-paper--live) |
| `TWITTER_BEARER_TOKEN` | Social signal | Not currently used -- see [Social signal](#social-signal-disabled-in-v1) |

Everything else in `.env.example` has a sane default (poll interval, paper
starting balance, dashboard port, DB path, watchlist config path).

### Why Helius *and* Birdeye

They're not interchangeable -- each is genuinely better at a different half
of the job:

- **Birdeye** is the natural fit for OHLCV candles (fib calculation) and
  volume/liquidity data -- that's its core product, and the free tier covers
  it directly with no derivation needed.
- **Helius** is the better fit for whale-move detection (its Enhanced
  Transactions API returns already-decoded swap data for a given address --
  including a token mint, which is how whale monitoring works here: polling
  transaction history *on the token itself*) and is needed regardless as the
  RPC endpoint for submitting live swap transactions -- meaningfully more
  reliable than the public `api.mainnet-beta.solana.com` endpoint.

If you only set `HELIUS_API_KEY` and leave `SOLANA_RPC_URL` at its default,
the bot automatically uses Helius's RPC instead of the public one.

### Social signal (disabled in v1)

Polling a fixed Twitter/X watchlist for sentiment was part of the original
plan, but X's API pricing makes it a real tradeoff: the **Free** tier can't
read tweets/timelines at all (post + auth only), so a bot that actually polls
accounts needs the **Basic tier at $200/month**. The scraping alternative is
free but fragile -- X actively blocks scrapers, most scraping libraries broke
when X locked down guest tokens, and an authenticated-session approach risks
your logged-in account getting flagged, on top of being a Terms of Service
gray area.

Given that, v1 ships with the social signal stubbed to a neutral `0`
(`src/signals/social.ts`) and `weights.social: 0` in the example watchlist
config, so it doesn't silently drag every combined score toward zero. The
three-signal interface (`evaluateToken` in `src/engine/scoring.ts`) is
already built to take a real social signal as a drop-in replacement --
wiring in the X API Basic tier later doesn't require touching the scoring
engine, just swapping the stub for a real implementation and rebalancing
`weights` in `config/watchlist.yaml`.

## Configuring the watchlist

Edit `config/watchlist.yaml` -- no code changes needed to add/remove tokens
or retune a token's strategy:

```yaml
tokens:
  - symbol: BONK
    address: DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
    enabled: true
    fibLevels: [0.236, 0.382, 0.5, 0.618, 0.786]
    swingLookbackHours: 72
    confluenceZonePct: 1.5
    whaleUsdThreshold: 25000
    volumeSpikeMultiplier: 3
    weights: { technical: 0.6, onchain: 0.4, social: 0 }
    buyThreshold: 0.6
    sellThreshold: -0.6
    positionSizePct: 5
    stopLossPct: 8
    takeProfitPct: 20

risk:
  maxConcurrentPositions: 5
  maxPositionSizePct: 10
  dailyLossLimitPct: 10
```

`weights.technical + weights.onchain + weights.social` must sum to `1.0` per
token (validated at load time). `risk` applies globally across all tokens.

## Risk management

Applied identically in paper and live mode, sized against the current
bankroll (paper: `PAPER_STARTING_BALANCE_USD`; live: the bot wallet's actual
SOL balance, priced live):

- **Position size**: `min(token.positionSizePct, risk.maxPositionSizePct)` of
  the bankroll.
- **Max concurrent positions**: blocks new buys once `risk.maxConcurrentPositions`
  positions are open (scoped per mode, so paper-mode testing never counts
  against live limits or vice versa).
- **Stop loss / take profit**: checked every poll cycle against each open
  position's price; whichever hits first (or a sell signal, if neither has)
  closes the position.
- **Daily loss limit**: if realized P&L for the current UTC day drops below
  `-risk.dailyLossLimitPct%` of the bankroll, new buys are blocked for the
  rest of the day. Existing open positions are still managed for exit --
  the halt only blocks *new* risk, it doesn't abandon what's already open.

## Logging & visibility

Every signal evaluation is written to `signal_log` -- including the ones that
don't trigger a trade -- with the technical/on-chain/social scores, the
combined score, a human-readable detail string per signal, and which action
(if any) was taken. The dashboard's Signal History table is a live view of
this table, and it's the first place to look when the bot didn't do
something you expected: the reason is always logged, not just the trades.

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

**Live mode swaps against SOL**, not USDC: buys are SOL -> token, sells are
token -> SOL, via Jupiter's free `lite-api.jup.ag` tier. Position quantity is
read back from the bot wallet's actual on-chain token balance after each
swap (not the swap quote's estimate), so it stays correct regardless of
slippage.

## Development

```bash
npm run dev          # tsx watch mode
npm run typecheck
npm test              # node:test -- pure-logic unit tests (fib math, risk checks)
npm run evaluate       # runs the technical+onchain+social pipeline once per
                        # watchlist token and logs to signal_log -- useful for
                        # sanity-checking live Birdeye/Helius responses without
                        # waiting for a full poll cycle
```

## Deployment (Railway)

`railway.json` is checked in (Nixpacks build, `npm start`, health check on
`/api/status`). Set the env vars from `.env.example` in the Railway project's
variables, including `BOT_PRIVATE_KEY` only once you're ready to go live --
leave it unset to run in paper mode indefinitely.
