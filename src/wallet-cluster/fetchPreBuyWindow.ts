import { getRecentTransactions } from "../data/helius.js";
import { parseSwapForWallet } from "../tail/parseSwap.js";
import type { EarlyBuyer } from "./types.js";

// Bounded, but generously so -- unlike other paginated loops in this
// codebase, this one may need to page through a lot of MORE RECENT activity
// just to reach a historical cutoff (Helius's API only supports
// signature-based "before" pagination, not a direct timestamp filter, so
// there's no way to jump straight to a point in time). A busy token with a
// main-wallet buy from days ago could exhaust this before ever reaching the
// target window -- see the truncated flag this returns for exactly that case.
const MAX_PAGES = 60;
const PAGE_SIZE = 100;

export interface PreBuyWindowResult {
  earlyBuyers: EarlyBuyer[];
  truncated: boolean; // true if MAX_PAGES was hit before the window's lower bound was reached -- coverage may be incomplete
  pagesScanned: number;
}

/**
 * Finds every wallet that bought this token in the `preBuyWindowMinutes`
 * before `cutoffAt` (the main wallet's own buy time). Pages backward from
 * "now" -- skips pages newer than cutoffAt without extracting from them,
 * starts collecting once timestamps fall inside [cutoffAt - window, cutoffAt),
 * stops once a page's oldest timestamp falls below that lower bound (or
 * MAX_PAGES is hit).
 */
export async function fetchPreBuyWindow(
  tokenAddress: string,
  cutoffAt: string,
  preBuyWindowMinutes: number,
): Promise<PreBuyWindowResult> {
  const cutoffMs = new Date(cutoffAt).getTime();
  const lowerBoundMs = cutoffMs - preBuyWindowMinutes * 60 * 1000;

  const earliestBuyByWallet = new Map<string, { buyAt: string; minutesBeforeMainBuy: number }>();
  let before: string | undefined;
  let page = 0;
  let truncated = false;

  for (; page < MAX_PAGES; page++) {
    const txs = await getRecentTransactions(tokenAddress, { limit: PAGE_SIZE, before });
    if (txs.length === 0) break;

    for (const tx of txs) {
      const txMs = tx.timestamp * 1000;
      if (txMs >= cutoffMs || txMs < lowerBoundMs) continue; // outside the window either direction

      const parsed = parseSwapForWallet(tx, tx.feePayer);
      if (!parsed.ok || parsed.swap.tokenAddress !== tokenAddress || parsed.swap.side !== "buy") continue;

      const minutesBeforeMainBuy = (cutoffMs - txMs) / 60000;
      const existing = earliestBuyByWallet.get(tx.feePayer);
      // Keep the EARLIEST buy per wallet within the window -- that's the
      // one most relevant to "bought ahead of the main wallet," not a
      // later top-up.
      if (!existing || minutesBeforeMainBuy > existing.minutesBeforeMainBuy) {
        earliestBuyByWallet.set(tx.feePayer, { buyAt: parsed.swap.onchainAt, minutesBeforeMainBuy });
      }
    }

    const oldestTxMs = txs[txs.length - 1].timestamp * 1000;
    before = txs[txs.length - 1]?.signature;
    if (oldestTxMs < lowerBoundMs) break; // paged past the window's lower bound -- done
    if (page === MAX_PAGES - 1) truncated = true;
  }

  const earlyBuyers: EarlyBuyer[] = [...earliestBuyByWallet.entries()].map(([walletAddress, v]) => ({
    walletAddress,
    buyAt: v.buyAt,
    minutesBeforeMainBuy: v.minutesBeforeMainBuy,
  }));

  return { earlyBuyers, truncated, pagesScanned: page + 1 };
}
