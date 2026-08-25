import { env } from "../config/env.js";
import { getTokenOverview } from "../data/priceProvider.js";
import { getTokenBalanceRaw } from "../solana/tokenAccounts.js";
import { swapSolForToken, swapTokenForSol, SOL_MINT } from "../execution/jupiter.js";
import { getBotSolBalance, type BotWalletSnapshot } from "../execution/liveTrading.js";
import { getTailLiveDailySnapshot, setTailLiveDailySnapshot } from "./db.js";

// Reserved so a buy never leaves the wallet unable to afford its own tx fees
// -- same figure the (now-deleted) main strategy's live execution used.
const FEE_RESERVE_SOL = 0.01;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializes every live buy/sell so at most one is ever mid-flight against
 * the wallet at a time. Both executeLiveBuy and executeLiveSell measure
 * proceeds/fills via a before/after balance delta on shared wallet state
 * (SOL balance for sells and the buy's fee-reserve check, the traded
 * token's balance for buys) -- if a SECOND live trade executes while the
 * first is still mid-swap, its own balance movement can land inside the
 * first trade's before/after window and get misattributed, corrupting the
 * measured fill price. Confirmed live: a tailed wallet dumping several
 * positions within the same few seconds (webhook.ts dispatches each
 * detected trade as an independent fire-and-forget call, with nothing
 * previously serializing them) produced a recorded live-sell price 7-8x
 * the real one on more than one trade in that same window. Serializing
 * trades one-at-a-time costs a little latency under a burst but makes
 * every fill measurement exclusive and correct -- correctness matters far
 * more than throughput for a bot trading real funds at this volume.
 */
let liveExecutionChain: Promise<unknown> = Promise.resolve();
function serializeLiveExecution<T>(fn: () => Promise<T>): Promise<T> {
  const result = liveExecutionChain.then(fn, fn);
  liveExecutionChain = result.then(
    () => {},
    () => {},
  );
  return result;
}

export function todayUtcDateString(): string {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD', UTC by construction (toISOString is always UTC)
}

/** Pure comparison, split out from checkDailyLossCapOk so it's testable without mocking the DB/network calls the real check needs. */
export function drawdownPct(snapshotBalanceUsd: number, currentBalanceUsd: number): number {
  return ((snapshotBalanceUsd - currentBalanceUsd) / snapshotBalanceUsd) * 100;
}

/**
 * Snapshots the live wallet's USD balance the first time it's checked each
 * UTC day, then compares every later check against that same-day snapshot
 * -- the honest baseline for "how much have we lost today," since a SOL
 * price move affects the whole balance, not just tail's own trades, so
 * summed trade P&L alone would be misleading. Only checked before a live
 * BUY; an already-open position still sells normally once its tailed wallet
 * sells, capped or not -- this only pauses new entries.
 *
 * Takes the current balance as a parameter rather than fetching it itself
 * -- the caller (executeLiveBuy) already has a fresh BotWalletSnapshot from
 * a single combined read, and re-fetching here would be a second redundant
 * price-provider round trip for every live buy.
 */
export async function checkDailyLossCapOk(currentBalanceUsd: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!env.TAIL_LIVE_DAILY_LOSS_CAP_ENABLED) return { ok: true };

  const today = todayUtcDateString();
  const snapshot = getTailLiveDailySnapshot();

  if (snapshot.snapshotDate !== today) {
    setTailLiveDailySnapshot(today, currentBalanceUsd);
    return { ok: true };
  }

  const snapshotBalanceUsd = snapshot.snapshotBalanceUsd!;
  const pct = drawdownPct(snapshotBalanceUsd, currentBalanceUsd);
  if (pct >= env.TAIL_LIVE_DAILY_LOSS_LIMIT_PCT) {
    return {
      ok: false,
      reason: `daily loss cap tripped: balance $${currentBalanceUsd.toFixed(2)} is down ${pct.toFixed(1)}% from today's $${snapshotBalanceUsd.toFixed(2)} snapshot (limit ${env.TAIL_LIVE_DAILY_LOSS_LIMIT_PCT}%) -- new live buys paused until the next UTC day`,
    };
  }
  return { ok: true };
}

export type LiveBuyResult =
  | { ok: true; signature: string; quantity: number; fillPriceUsd: number }
  | { ok: false; reason: string };

/**
 * Real Jupiter swap, sized off the wallet's actual current balance (not
 * TAIL_STARTING_BALANCE_USD, which is paper-only). Fill quantity is read
 * back from the on-chain balance delta before/after, not the quote's
 * outAmount estimate, so it's correct regardless of slippage.
 *
 * Takes a BotWalletSnapshot (see execution/liveTrading.ts) instead of
 * fetching the wallet's balance/SOL price itself -- the caller already has
 * one fresh read (it needed totalBalanceUsd to compute usdSize in the first
 * place), and re-fetching here would triple the price-provider calls this
 * one live buy makes for no benefit. That snapshot can go slightly stale if
 * this call is queued behind another live trade (see serializeLiveExecution
 * below) -- an acceptable tradeoff: the balance/price it's stale against
 * only affects sizing and the fee-reserve check, never the fill price
 * itself, which is still always read fresh at actual execution time.
 */
export function executeLiveBuy(tokenAddress: string, usdSize: number, wallet: BotWalletSnapshot): Promise<LiveBuyResult> {
  return serializeLiveExecution(() => executeLiveBuyInner(tokenAddress, usdSize, wallet));
}

async function executeLiveBuyInner(tokenAddress: string, usdSize: number, wallet: BotWalletSnapshot): Promise<LiveBuyResult> {
  // Everything below is wrapped in one try/catch, not just the swap itself
  // -- by the time this is called, mirror.ts has already inserted a
  // 'pending' tail_trades row, and the only thing that marks it
  // unfillable_entry is a clean {ok:false} return here. A rate-limit or
  // network failure from the daily-loss-cap check or the balance/price
  // lookups (both hit the price provider, same as the swap) throwing
  // uncaught instead would leave that row stuck open with no quantity
  // forever -- a real bug found from a live GeckoTerminal 429.
  try {
    const capCheck = await checkDailyLossCapOk(wallet.totalBalanceUsd);
    if (!capCheck.ok) return { ok: false, reason: capCheck.reason };

    const solAmount = usdSize / wallet.solPriceUsd;
    if (solAmount + FEE_RESERVE_SOL > wallet.solBalance) {
      return {
        ok: false,
        reason: `insufficient SOL balance: need ~${solAmount.toFixed(4)} + ${FEE_RESERVE_SOL} fee reserve, have ${wallet.solBalance.toFixed(4)}`,
      };
    }

    const before = await getTokenBalanceRaw(tokenAddress);
    const result = await swapSolForToken(tokenAddress, solAmount, env.TAIL_LIVE_SLIPPAGE_BPS);

    // A hosted/load-balanced RPC endpoint can serve this immediate
    // follow-up read from a backend node whose token-account index briefly
    // lags the just-confirmed swap -- a real, successful buy read back as
    // "balance didn't increase" would mark the trade unfillable_entry while
    // the wallet actually holds the tokens (real SOL already spent), with
    // nothing left tracking that position. A few short retries distinguish
    // that lag from a genuine failure at low cost (only paid when the first
    // read comes back stale).
    let quantity = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(400);
      const after = await getTokenBalanceRaw(tokenAddress);
      quantity = (after?.uiAmount ?? 0) - (before?.uiAmount ?? 0);
      if (quantity > 0) break;
    }
    if (quantity <= 0) {
      return { ok: false, reason: `swap ${result.signature} confirmed but token balance didn't increase (checked ${4} times)` };
    }

    return { ok: true, signature: result.signature, quantity, fillPriceUsd: usdSize / quantity };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export type LiveSellResult =
  | { ok: true; signature: string; quantitySold: number; fillPriceUsd: number }
  | { ok: false; reason: string };

/**
 * Sells the wallet's FULL current on-chain balance of the token -- tail
 * positions are a single lump buy/sell, no partial scale-outs, so "how much
 * do we actually hold right now" (read fresh, not the DB's recorded
 * quantity) is always the right amount to sell, whether triggered by
 * detecting the tailed wallet's own sell or the dashboard's manual Sell
 * button.
 *
 * SOL proceeds are read from the wallet's actual SOL balance delta
 * before/after the swap, NOT swapTokenForSol's result.outAmount -- that's
 * only the pre-trade quote's estimate (jupiter.ts forwards quote.outAmount
 * verbatim), which can differ from real proceeds by the actual slippage
 * between quote and execution. An earlier version of this function trusted
 * the quote estimate here while executeLiveBuy already avoided the same
 * mistake on the buy side (see its docstring) -- every live sell's recorded
 * fill price and P&L was silently off by real slippage until this fix. The
 * balance delta also naturally nets out the tx fee (a real cost, correctly
 * reducing recorded proceeds slightly) with no double-counting risk the way
 * summing transfer legs would have -- see parseSwap.ts's netLegsForWallet
 * docstring for that unrelated but analogous bug.
 */
export function executeLiveSell(tokenAddress: string): Promise<LiveSellResult> {
  return serializeLiveExecution(() => executeLiveSellInner(tokenAddress));
}

async function executeLiveSellInner(tokenAddress: string): Promise<LiveSellResult> {
  try {
    const balance = await getTokenBalanceRaw(tokenAddress);
    if (!balance || balance.amountRaw === "0") {
      return { ok: false, reason: `no on-chain balance found for ${tokenAddress} -- nothing to sell` };
    }

    const solBefore = await getBotSolBalance();
    const result = await swapTokenForSol(tokenAddress, balance.amountRaw, env.TAIL_LIVE_SLIPPAGE_BPS);
    const solAfter = await getBotSolBalance();

    const solReceived = solAfter - solBefore;
    if (solReceived <= 0) {
      return { ok: false, reason: `swap ${result.signature} confirmed but SOL balance didn't increase` };
    }

    const solOverview = await getTokenOverview(SOL_MINT);
    const usdReceived = solReceived * solOverview.price;

    return { ok: true, signature: result.signature, quantitySold: balance.uiAmount, fillPriceUsd: usdReceived / balance.uiAmount };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
