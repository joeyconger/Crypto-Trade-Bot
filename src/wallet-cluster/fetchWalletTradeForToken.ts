import { getRecentTransactions } from "../data/helius.js";
import { parseSwapForWallet } from "../tail/parseSwap.js";

const MAX_PAGES = 20;
const PAGE_SIZE = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WalletTokenTrade {
  sellAt: string | null; // earliest sell strictly after sinceBuyAt, if any
}

/**
 * Scoped, cheaper cousin of fetchMainWalletTrades.ts -- looks for one
 * wallet's SELL of ONE specific token, anchored to a KNOWN buy timestamp
 * (`sinceBuyAt`, from the pre-buy-window scan that already found this
 * candidate) rather than independently re-deriving "the" buy. Re-deriving
 * it was a real bug: if a candidate traded the same token more than once,
 * picking its overall-earliest buy in this function's own scan could
 * silently refer to a DIFFERENT entry than the one that actually put it in
 * the pre-buy-window overlap, producing a hold time for the wrong trade
 * entirely. Anchoring to the already-known buy removes that ambiguity.
 *
 * Used for the per-candidate sell-timing comparison (step 4 of the
 * pipeline), so this only runs for wallets that already cleared
 * minOverlapCount, not every early buyer scanned in step 2.
 */
export async function fetchWalletTradeForToken(wallet: string, tokenAddress: string, sinceBuyAt: string): Promise<WalletTokenTrade> {
  const sinceMs = new Date(sinceBuyAt).getTime();
  let earliestSellAfterBuy: string | null = null;

  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(1200); // paced -- see fetchPreBuyWindow.ts's comment on why this matters
    const txs = await getRecentTransactions(wallet, { limit: PAGE_SIZE, before });
    if (txs.length === 0) break;

    for (const tx of txs) {
      if (tx.timestamp * 1000 < sinceMs) continue; // older than the anchor buy -- not relevant to this hold period

      const parsed = parseSwapForWallet(tx, wallet);
      if (!parsed.ok || parsed.swap.tokenAddress !== tokenAddress || parsed.swap.side !== "sell") continue;

      if (!earliestSellAfterBuy || new Date(parsed.swap.onchainAt) < new Date(earliestSellAfterBuy)) {
        earliestSellAfterBuy = parsed.swap.onchainAt;
      }
    }

    const oldestTxMs = txs[txs.length - 1].timestamp * 1000;
    before = txs[txs.length - 1]?.signature;
    if (oldestTxMs < sinceMs) break; // paged past the anchor buy -- nothing older can be relevant
  }

  return { sellAt: earliestSellAfterBuy };
}
