import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { env } from "../config/env.js";
import { getTokenOverview } from "../data/priceProvider.js";
import { getTokenBalanceRaw } from "../solana/tokenAccounts.js";
import { swapSolForToken, swapTokenForSol, SOL_MINT } from "../execution/jupiter.js";
import { getBotSolBalance, getBotWalletBalanceUsd } from "../execution/liveTrading.js";
import { getTailLiveDailySnapshot, setTailLiveDailySnapshot } from "./db.js";

// Reserved so a buy never leaves the wallet unable to afford its own tx fees
// -- same figure the (now-deleted) main strategy's live execution used.
const FEE_RESERVE_SOL = 0.01;

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
 */
export async function checkDailyLossCapOk(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!env.TAIL_LIVE_DAILY_LOSS_CAP_ENABLED) return { ok: true };

  const currentBalanceUsd = await getBotWalletBalanceUsd();
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
 */
export async function executeLiveBuy(tokenAddress: string, usdSize: number): Promise<LiveBuyResult> {
  // Everything below is wrapped in one try/catch, not just the swap itself
  // -- by the time this is called, mirror.ts has already inserted a
  // 'pending' tail_trades row, and the only thing that marks it
  // unfillable_entry is a clean {ok:false} return here. A rate-limit or
  // network failure from the daily-loss-cap check or the balance/price
  // lookups (both hit the price provider, same as the swap) throwing
  // uncaught instead would leave that row stuck open with no quantity
  // forever -- a real bug found from a live GeckoTerminal 429.
  try {
    const capCheck = await checkDailyLossCapOk();
    if (!capCheck.ok) return { ok: false, reason: capCheck.reason };

    const [solBalance, solOverview] = await Promise.all([getBotSolBalance(), getTokenOverview(SOL_MINT)]);
    const solAmount = usdSize / solOverview.price;
    if (solAmount + FEE_RESERVE_SOL > solBalance) {
      return {
        ok: false,
        reason: `insufficient SOL balance: need ~${solAmount.toFixed(4)} + ${FEE_RESERVE_SOL} fee reserve, have ${solBalance.toFixed(4)}`,
      };
    }

    const before = await getTokenBalanceRaw(tokenAddress);
    const result = await swapSolForToken(tokenAddress, solAmount, env.TAIL_LIVE_SLIPPAGE_BPS);
    const after = await getTokenBalanceRaw(tokenAddress);

    const quantity = (after?.uiAmount ?? 0) - (before?.uiAmount ?? 0);
    if (quantity <= 0) {
      return { ok: false, reason: `swap ${result.signature} confirmed but token balance didn't increase` };
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
 */
export async function executeLiveSell(tokenAddress: string): Promise<LiveSellResult> {
  try {
    const balance = await getTokenBalanceRaw(tokenAddress);
    if (!balance || balance.amountRaw === "0") {
      return { ok: false, reason: `no on-chain balance found for ${tokenAddress} -- nothing to sell` };
    }

    const result = await swapTokenForSol(tokenAddress, balance.amountRaw, env.TAIL_LIVE_SLIPPAGE_BPS);
    const solOverview = await getTokenOverview(SOL_MINT);
    const solReceived = Number(result.outAmount) / LAMPORTS_PER_SOL;
    const usdReceived = solReceived * solOverview.price;

    return { ok: true, signature: result.signature, quantitySold: balance.uiAmount, fillPriceUsd: usdReceived / balance.uiAmount };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
