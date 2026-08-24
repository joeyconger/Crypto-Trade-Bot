# Vibes & Fibs

A Solana trading bot built around **wallet-tailing**: mirror specific
wallets' on-chain swaps, either as a paper-trading experiment (measuring
how much of a wallet's edge survives real-world lag) or, once you've
reviewed that data, as real execution with the bot's own funded wallet. Ships
in **paper trading mode by default** -- live trading is an explicit,
double-gated opt-in per wallet. A separate, standalone research tool
(`src/wallet-cluster/`) can also try to identify a tracked trader's likely
side wallets from on-chain correlation, for investigative purposes only --
it never executes anything.

## Architecture at a glance

- **Runtime**: Node.js + TypeScript, run directly via `tsx` (no build step in
  production).
- **Execution**: the bot holds its **own** Solana keypair, loaded from an env
  var and funded manually by sending SOL from your Phantom wallet. Phantom is
  a browser extension and can't run headless, so it's never involved at
  runtime -- the bot signs and sends its own transactions via
  [`@solana/web3.js`](https://github.com/anza-xyz/solana-web3.js) and the
  [Jupiter Swap API](https://dev.jup.ag/docs/swap-api/), only when a tailed
  wallet is in live mode (`src/tail/liveExecution.ts`).
- **Data**: [Helius](https://helius.dev) for RPC + wallet transaction history
  (both the tail webhook's payload shape and wallet-cluster's analysis),
  GeckoTerminal (default) or Birdeye for current price/market cap. See
  [Price/OHLCV data provider](#priceohlcv-data-provider-birdeye-or-geckoterminal)
  and [Why Helius *and* Birdeye](#why-helius-and-birdeye) below.
- **Storage**: SQLite via `better-sqlite3` (`data/bot.sqlite`, gitignored) --
  one physical file, three independent schemas layered onto it (tail,
  wallet-cluster, and a small shared price-pool cache), each with its own
  `schema.sql` and init function.
- **Dashboard**: a single Express service serves everything (`src/dashboard/`)
  on one process -- one Railway deployment.

```
Helius Enhanced webhook (SWAP events for tailed wallets)
        |
        v
src/tail/webhook.ts          -- POST /api/tail/webhook, responds 200 immediately
        |                        (before any fill work, so Helius never retries)
        v
src/tail/parseSwap.ts        -- nets transfer legs into a buy/sell for that wallet
        |
        +--> paper mode: src/tail/simulateFill.ts   (waits TAIL_SIMULATED_DELAY_SECONDS,
        |                                             then a real price lookup -- tests lag cost)
        +--> live mode:  src/tail/liveExecution.ts   (real Jupiter swap, sized off the
                                                        bot's actual current balance)
        |
        v
src/tail/db.ts (tail_trades, tail_wallets, tail_webhook_log, tail_coverage_gaps)
        |
        v
src/dashboard/  -- add/remove tailed wallets, per-wallet P&L breakdown,
                    manual Sell button, live/paper trade history
```

`src/wallet-cluster/` is entirely separate and manually triggered (`npm run
wallet-cluster`) -- it never feeds into or reads from the pipeline above.

## Setup

```bash
npm install
cp .env.example .env   # fill in the values below
npm run typecheck
npm test
npm start              # runs the dashboard (and tail's webhook receiver)
```

The dashboard is served on `DASHBOARD_PORT` (default `4000`; Railway's
injected `PORT` takes priority automatically). Open it in a browser to add/
remove tailed wallets, watch trade history and per-wallet P&L, and (if
`TAIL_LIVE_TRADING` is on) see the live wallet's real balance.

## Required API keys / env vars

| Var | Required for | Where to get it |
|---|---|---|
| `HELIUS_API_KEY` | RPC (also doubles as the default `SOLANA_RPC_URL`) + `wallet-cluster`'s transaction-history lookups | [helius.dev](https://helius.dev) -- free tier is enough for one bot |
| `BIRDEYE_API_KEY` | Current price/market cap -- only if `PRICE_PROVIDER=birdeye` | [birdeye.so/find-more](https://birdeye.so/find-more) -- free Standard tier |
| `GECKOTERMINAL_API_KEY` | Optional but strongly recommended if `PRICE_PROVIDER=geckoterminal` (the default) | [coingecko.com/en/api/pricing](https://www.coingecko.com/en/api/pricing) -- the free "Demo" tier, not a paid plan |
| `BOT_PRIVATE_KEY` | Tail live trading only | Run `npm run generate-keypair` yourself -- see [Wallet tail: going live](#going-live) |

Everything else in `.env.example` has a sane default (dashboard port, DB
path, tail sizing/delay/labels).

### Price/OHLCV data provider: Birdeye or GeckoTerminal

`PRICE_PROVIDER` picks which service serves current price/market cap
(`src/data/priceProvider.ts` is the single switch point -- every other
module imports through it, never a specific provider directly):

- **`birdeye`** -- the more thoroughly exercised option, but needs
  `BIRDEYE_API_KEY` and a metered plan (the free Standard tier has a
  monthly call cap). Once that cap is hit, Birdeye stops serving requests
  for the rest of the billing period.
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
  endpoint is scoped to a liquidity pool rather than a token mint directly
  -- `src/data/geckoterminal.ts` resolves and caches each token's primary
  pool (by reserve size) the first time it's seen (`token_pool_cache`
  table), so that's a one-time cost per token, not a per-lookup one -- and,
  like every provider integration in this project, its field-shape mapping
  is my best-effort and unverified from a sandbox with no live network
  access -- check the raw error message on first run if a lookup comes back
  empty rather than assuming the tail/wallet-cluster logic itself is at
  fault.

Switching providers is a one-line env change (`PRICE_PROVIDER=birdeye` or
`geckoterminal`) and a redeploy -- no code changes, and `token_pool_cache`
sitting unused when on Birdeye is harmless. Both providers retry with
backoff on a 429.

### Why Helius *and* Birdeye

- **Birdeye** is the natural fit for current price/market cap and liquidity
  data -- that's its core product, free tier covers it directly.
- **Helius** is the better fit for wallet transaction history (its Enhanced
  Transactions API returns already-decoded swap data for any address --
  what the tail webhook payload and `wallet-cluster`'s analysis both rely
  on) and is needed regardless as the RPC endpoint for live swaps once a
  tailed wallet goes live.

If you only set `HELIUS_API_KEY` and leave `SOLANA_RPC_URL` at its default,
the bot automatically uses Helius's RPC instead of the public one.

## Development

```bash
npm run dev             # tsx watch mode
npm run typecheck
npm test                 # node:test -- pure-logic unit tests
npm run generate-keypair # creates the bot's own Solana keypair (run yourself, see below)
npm run tail-summary      # prints the wallet-tail module's summary stats --
                           # optionally `-- --days 7` to scope the window;
                           # see "Wallet tail" below
npm run wallet-cluster -- --wallet <address>  # runs the side-wallet
                           # correlation analysis -- see "Wallet clustering" below
```

## Wallet tail

`src/tail/` mirrors specific wallets' on-chain swaps -- paper by default,
real execution once you explicitly turn a run live (see
[Going live](#going-live) below). Its own DB tables (`tail_trades`,
`tail_wallets`, `tail_webhook_log`, `tail_coverage_gaps`), namespaced
`tail_*`, no shared state with `wallet-cluster`.

### What paper mode is measuring

The question isn't "would mirroring this wallet have made money" alone --
it's **how much of that result is real edge vs. how much is lost to lag**.
Every mirrored paper trade fetches its fill price only after waiting
`TAIL_SIMULATED_DELAY_SECONDS` (default 5s, representing route-building + tx
submission + confirmation) past detection, then prices at THAT later moment
-- not the wallet's price, not the price at the instant of detection. The
dashboard and `npm run tail-summary` show that realistic (lagged) P&L
side-by-side with what the same trades would have made filled instantly at
the wallet's exact price/time. The gap between them is the lag cost, and
it's a real input into whether going live is worth it -- not the raw P&L
number alone.

If no reliable price exists at fill time (token too new, no pool data), the
trade is logged `unfillable_entry`/`unfillable_exit` rather than a fabricated
price -- these are counted and shown separately, never silently dropped or
guessed.

### Setup

1. Set `TAIL_ENABLED=true`, `TAIL_WALLET_ADDRESSES` (comma-separated,
   defaults to the wallet this module was built around), and optionally
   `TAIL_WEBHOOK_SECRET` (strongly recommended) in `.env`.
2. In your Helius dashboard, create an **Enhanced webhook** (transaction
   type `SWAP`), watching the same address(es) as `TAIL_WALLET_ADDRESSES`,
   pointed at `https://<your-deploy>/api/tail/webhook`. If you set
   `TAIL_WEBHOOK_SECRET`, put the exact same value in Helius's
   "Authorization Header" field -- every incoming POST is checked against it.
3. This is push-based, not polling -- Helius calls your endpoint the moment
   it sees a matching transaction, which is the whole point (polling would
   add latency on top of everything the delay is already measuring).

Multiple wallets can be tailed at once. `TAIL_WALLET_ADDRESSES` (+ optional
index-aligned `TAIL_WALLET_LABELS`, e.g. `addr1,addr2` + `omo,Sling`) seeds
the initial list on first startup, but the actual watch list lives in the
database (`tail_wallets` table) from then on -- wallets can be added or
removed live from the dashboard's "Tailed wallets" panel, no redeploy or env
var edit needed. Labels are purely cosmetic -- an address with none just
falls back to a shortened form. With more than one wallet tailed, the
dashboard shows a per-wallet P&L breakdown (%, $, trade counts) alongside
the combined "overall" numbers, and each row in the trades table is tagged
with which wallet it came from. Removing a wallet disables it (its trade
history stays visible, grayed out) rather than deleting it outright.

#### Auto-syncing the Helius webhook when adding/removing wallets

Adding a wallet in the dashboard doesn't automatically make Helius start
sending its transactions -- Helius only forwards whatever address list is
configured on *your* webhook. To close that gap, set
`TAIL_HELIUS_WEBHOOK_ID` to your webhook's ID (the last segment of its URL,
e.g. `https://api.helius.xyz/v0/webhooks/<this-part>` -- also visible via
Helius's webhook API or dashboard). With it set, the dashboard's add/remove
actions also call Helius's API to update that webhook's `accountAddresses`
in place, so tailing actually starts/stops without a manual step. Without
it, wallets added/removed in the dashboard still take effect on this app's
side immediately; you just also need to update the webhook's address list
yourself in Helius's dashboard. Either way, the dashboard tells you which
happened after each add/remove, since the Helius call is unverified from
this sandbox (no live network access here) and best-effort -- a failure
there never blocks the wallet from being added/removed on this app's side.

The webhook payload shape (Helius's "enhanced transaction" format) is this
project's best understanding, unverified from this sandbox (no live network
access here) -- same caveat as every Birdeye/GeckoTerminal integration
elsewhere in this repo. If real deliveries don't parse, they're logged to
`tail_webhook_log` as `parse_error` with the reason rather than silently
dropped or crashing the endpoint; check that table (or the dashboard's
webhook-log view) against a raw payload before assuming the tailing logic
is at fault.

### Coverage gaps

The webhook handler logs every delivery it receives -- successful,
ignored, or failed to parse -- specifically so "the wallet was quiet" can be
told apart from "something broke and we stopped seeing events." It also logs
a `startup_gap` note if the server comes up after a suspiciously long
silence. This can only see gaps on **this server's** side (crashes, restarts,
handler errors); it has no way to know whether Helius attempted delivery
during a gap and failed, since a delivery that never reached this server
leaves no record here at all.

### Going live

**Real funds, real swaps, no per-trade approval step, the instant a tailed
wallet trades.** Review the paper track record first -- the lag-cost
comparison above is exactly the data point that should inform whether this
is worth doing.

Live trading requires all of the following, on purpose -- there's no single
switch:

1. **Fund the bot's own wallet.** Run `npm run generate-keypair` **yourself**
   (locally, or in a Railway shell) -- it prints a public address to fund from
   Phantom and a base58 secret. Run it yourself rather than asking anyone else
   to, and never paste the secret into a chat log or anywhere outside your
   own env vars.
2. Put that secret in `BOT_PRIVATE_KEY`.
3. Send SOL to the printed public address from Phantom. This is the bot's
   entire live risk capital -- size it deliberately.
4. Set **both** `TAIL_LIVE_TRADING=true` and `TAIL_LIVE_TRADING_CONFIRM=true`.
   Both are required; either one alone leaves tail in paper mode. If either
   is set without `BOT_PRIVATE_KEY`, the bot refuses to start rather than
   silently falling back to paper mode under a misleading label.
5. Redeploy. The dashboard's tail section shows a loud LIVE indicator and
   the wallet's real current balance once it's confirmed running live.

To go back to paper mode, set `TAIL_LIVE_TRADING=false` (or drop
`TAIL_LIVE_TRADING_CONFIRM`) and redeploy.

Live trades size off the wallet's **actual current balance**
(`TAIL_POSITION_SIZE_PCT` of it per trade), not the paper mode's fictional
`TAIL_STARTING_BALANCE_USD`. Swaps go through Jupiter's free `lite-api.jup.ag`
tier with a configurable slippage tolerance (`TAIL_LIVE_SLIPPAGE_BPS`,
default 100 = 1%) on both entries and exits (including the manual Sell
button). Fill quantities are always read back from the chain, not a swap
quote's estimate, so they're correct regardless of slippage.

**Daily loss cap**: if the live wallet's USD balance drops more than
`TAIL_LIVE_DAILY_LOSS_LIMIT_PCT` (default 20%) from its value at the start of
the current UTC day, new live buys pause automatically until the next UTC
day. This only blocks *new* entries -- any position already open still sells
normally the moment its tailed wallet sells. It's not a per-trade stop-loss,
just a backstop against a bad day (or a bad tailed wallet) silently draining
the whole balance unattended.

**Manual Sell button**: closes an open position immediately at the current
market price -- useful when there's no reliable automated exit signal (e.g.
no scraper for a trader's off-chain "callouts"). For a live position this is
a real swap, same slippage tolerance as any other live exit; for a paper
position it's a simulated close, same as always. Either way it's tagged so
the trade history shows it was a manual close, not a detected wallet sell.

## Wallet clustering (research module)

`src/wallet-cluster/` is a standalone, manually-triggered analysis tool: it
attempts to identify likely "side wallets" of a tracked trader by finding
other wallets that consistently buy the same tokens shortly before that
trader's public buys, across as many independent tokens as possible.

**This is correlation-based inference, not proof of identity or ownership.**
Every output is a confidence score -- "consistent with being a controlled
wallet" -- never a definitive claim. Nothing in this module reads as
"confirmed," "is the same person," or similar anywhere in its code, logs, or
UI. It has **no execution path of any kind** -- it only reads chain data and
writes analysis results to its own tables.

### Running it

```bash
npm run wallet-cluster -- --wallet <address>
# optional: --pre-buy-window 60 --min-overlap 4 --max-tokens 15
```

Pulls the wallet's last `--max-tokens` buys automatically (or fewer, if that's
all it's traded), then for each one scans every other wallet that bought the
same token in the `--pre-buy-window` minutes beforehand. Wallets appearing as
early buyers across enough of those tokens (`--min-overlap`, default 4 --
below that isn't statistically distinguishable from coincidental sniping)
get ranked and scored.

### What the score means

**Overlap count is the dominant signal** -- how many of the input tokens a
candidate shows up as an early buyer on. Everything else is secondary:

- **Funding link** (direct transfer, or a shared one-hop counterparty --
  reuses `src/onchain/walletConnectivity.ts`'s `findFundingLink` heuristic)
  acts as a **multiplier** on the overlap-based score, not a flat bonus.
- **Sell-timing pattern** (does the candidate exit sooner than the main
  wallet, per overlapping token -- reported per-token, never collapsed into
  one number since hold times vary a lot token to token) and **fee-payer
  overlap** are minor, capped corroborating bonuses -- neither can alone
  push a low-overlap candidate into high confidence.

See `src/wallet-cluster/scoring.ts` for the exact weighting and the reasoning
behind it -- it's a documented judgment call, not a formula calibrated
against any ground-truth labeled dataset (none exists for this).

If a check (funding link, sell timing, fee payer) fails to complete for a
candidate, that's reported explicitly as a data gap, never silently treated
as "no."

### Sample-size honesty

A run flags itself `sampleTooThin` (and says so prominently in the CLI
report and dashboard, not just in a buried field) when the wallet's trade
history is too short (fewer than 5 tokens) or too clustered in time (all
buys within 6 hours) to make "consistent overlap across independent tokens"
a meaningful claim -- a bot sniping every launch in one busy hour looks
identical to a wallet specifically tracking the main wallet otherwise.

### Exclusion-list suggestions -- manual review only

Candidates clearing both a higher overlap bar (`exclusionSuggestionMinOverlap`,
default 6) AND a funding link get flagged `suggestedForExclusion` -- shown in
the dashboard's wallet-clustering section with Approve/Reject buttons. This
never auto-populates anywhere or changes any config -- a human reviews and
approves each addition; the review action just records a decision.

### Results

Stored in `wallet_cluster_runs`/`wallet_cluster_candidates` (own tables,
namespaced, no foreign keys into `tail`'s schema), tagged with the main
wallet and run date so repeated runs over time are comparable. View them via
the dashboard's "Wallet clustering" section (shows the latest run) or query
the tables directly for history.

## Deployment (Railway)

`railway.json` is checked in (Nixpacks build, `npm start`, health check on
`/`). Set the env vars from `.env.example` in the Railway project's
variables, including `BOT_PRIVATE_KEY` only once you're ready to go live on
a tailed wallet -- leave it unset to run in paper mode indefinitely.

**Persist the database across redeploys.** Railway's container filesystem is
ephemeral by default -- every redeploy spins up a fresh container, and
`data/bot.sqlite` goes with it unless it's on persistent storage. Before you
care about keeping trade history:

1. In the Railway dashboard, add a **Volume** to the service, mounted at
   e.g. `/data`.
2. Set `DATABASE_PATH=/data/bot.sqlite` in the service's env vars.
3. Redeploy once with that in place.

After that, the SQLite file survives redeploys independently of the app
container -- push code changes freely without losing tail/wallet-cluster
history.
