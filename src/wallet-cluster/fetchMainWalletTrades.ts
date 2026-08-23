import { getRecentTransactions } from "../data/helius.js";
import { parseSwapForWallet } from "../tail/parseSwap.js";
import { resolveTokenSymbol } from "../data/resolveTokenSymbol.js";
import type { MainWalletTrade } from "./types.js";

const MAX_PAGES = 20;
const PAGE_SIZE = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Auto-detects the main wallet's recent buys (and, where visible in the same
 * scan, a matching later sell) by paging backward through its transaction
 * history. Runs each SWAP through the SAME parser the wallet-tail module
 * uses (src/tail/parseSwap.ts) rather than reimplementing "which leg is the
 * trade, which is the quote, ignore multi-leg dust" -- that parser already
 * had a real bug found and fixed against live data earlier, so reusing it
 * here avoids reintroducing the same class of mistake.
 *
 * Bounded to MAX_PAGES x PAGE_SIZE transactions scanned -- a one-time cost
 * for a manually-triggered research run, not a per-cycle bot cost, but still
 * capped so a very high-activity wallet can't make this run indefinitely.
 */
export async function fetchMainWalletTrades(mainWallet: string, maxTokens: number): Promise<MainWalletTrade[]> {
  const buysByToken = new Map<string, { buyAt: string; buyTxSignature: string }>();
  const sells: { tokenAddress: string; sellAt: string; sellTxSignature: string }[] = [];

  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(1200); // paced -- see fetchPreBuyWindow.ts's comment on why this matters
    const txs = await getRecentTransactions(mainWallet, { limit: PAGE_SIZE, before });
    if (txs.length === 0) break;

    for (const tx of txs) {
      const parsed = parseSwapForWallet(tx, mainWallet);
      if (!parsed.ok) continue;

      if (parsed.swap.side === "buy") {
        if (!buysByToken.has(parsed.swap.tokenAddress)) {
          buysByToken.set(parsed.swap.tokenAddress, { buyAt: parsed.swap.onchainAt, buyTxSignature: parsed.swap.txSignature });
        }
      } else {
        sells.push({ tokenAddress: parsed.swap.tokenAddress, sellAt: parsed.swap.onchainAt, sellTxSignature: parsed.swap.txSignature });
      }
    }

    before = txs[txs.length - 1]?.signature;
    if (buysByToken.size >= maxTokens) break;
  }

  const limitedEntries = [...buysByToken.entries()].slice(0, maxTokens);

  const trades: MainWalletTrade[] = await Promise.all(
    limitedEntries.map(async ([tokenAddress, buy]) => {
      // Earliest sell of this token strictly after the buy, if one showed up
      // anywhere in the scanned window -- since we paged newest-first, a
      // later sell is very likely to have already been seen by the time we
      // reach its earlier buy, but this reconciliation doesn't depend on
      // encounter order either way.
      const matchingSells = sells
        .filter((s) => s.tokenAddress === tokenAddress && new Date(s.sellAt) > new Date(buy.buyAt))
        .sort((a, b) => new Date(a.sellAt).getTime() - new Date(b.sellAt).getTime());
      const sell = matchingSells[0];

      return {
        tokenAddress,
        tokenSymbol: await resolveTokenSymbol(tokenAddress),
        buyAt: buy.buyAt,
        buyTxSignature: buy.buyTxSignature,
        sellAt: sell?.sellAt,
        sellTxSignature: sell?.sellTxSignature,
      };
    }),
  );

  // Most recent buy first -- matches "pull its last N buys" framing.
  return trades.sort((a, b) => new Date(b.buyAt).getTime() - new Date(a.buyAt).getTime());
}
