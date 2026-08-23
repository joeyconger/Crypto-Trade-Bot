import { getRecentTransactions } from "../data/helius.js";
import { parseSwapForWallet } from "../tail/parseSwap.js";

const MAX_PAGES = 20;
const PAGE_SIZE = 100;

export interface WalletTokenTrade {
  buyAt: string | null;
  sellAt: string | null; // earliest sell strictly after buyAt, if any
}

/**
 * Scoped, cheaper cousin of fetchMainWalletTrades.ts -- looks for one
 * wallet's buy/sell of ONE specific token, rather than reconstructing its
 * whole trade history. Used for the per-candidate sell-timing comparison
 * (step 4 of the pipeline), so this only runs for wallets that already
 * cleared minOverlapCount, not every early buyer scanned in step 2.
 */
export async function fetchWalletTradeForToken(wallet: string, tokenAddress: string): Promise<WalletTokenTrade> {
  let buyAt: string | null = null;
  let earliestSellAfterBuy: string | null = null;
  const sells: string[] = [];

  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const txs = await getRecentTransactions(wallet, { limit: PAGE_SIZE, before });
    if (txs.length === 0) break;

    for (const tx of txs) {
      const parsed = parseSwapForWallet(tx, wallet);
      if (!parsed.ok || parsed.swap.tokenAddress !== tokenAddress) continue;

      if (parsed.swap.side === "buy") {
        if (!buyAt || new Date(parsed.swap.onchainAt) < new Date(buyAt)) buyAt = parsed.swap.onchainAt;
      } else {
        sells.push(parsed.swap.onchainAt);
      }
    }

    before = txs[txs.length - 1]?.signature;
    // Once both a buy and at least one sell candidate are found, further
    // (older) pages can't change the answer -- the buy can only get
    // earlier, and we already want the earliest post-buy sell, which needs
    // all sells gathered first; stop once we plausibly have both.
    if (buyAt && sells.length > 0) break;
  }

  if (buyAt) {
    const afterBuy = sells.filter((s) => new Date(s) > new Date(buyAt!)).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    earliestSellAfterBuy = afterBuy[0] ?? null;
  }

  return { buyAt, sellAt: earliestSellAfterBuy };
}
