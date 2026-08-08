import { getRecentTransactions } from "../data/helius.js";
import { insertWalletActivity, getLastTxSignature, setLastTxSignature } from "../db/index.js";
import type { TokenConfig } from "../types/index.js";

/**
 * Polls transactions on the token mint itself (Helius returns tx history for
 * any address, mints included) and records EVERY observed buy/sell -- not
 * just threshold-qualifying ones -- into wallet_activity. This is the raw
 * feed wallet reputation and entry-trigger confirmation are built from;
 * size/age/tag/reputation filtering happens later in onchain/entryTrigger.ts.
 */
export async function pollWalletActivity(token: TokenConfig, currentPriceUsd: number): Promise<number> {
  const lastSignature = getLastTxSignature(token.address);
  const txs = await getRecentTransactions(token.address, { limit: 100 });
  if (txs.length === 0) return 0;

  const latestSignature = txs[0]?.signature;
  const cutoffIdx = lastSignature ? txs.findIndex((t) => t.signature === lastSignature) : -1;
  const newTxs = cutoffIdx === -1 ? txs : txs.slice(0, cutoffIdx);

  let recorded = 0;
  for (const tx of newTxs) {
    if (tx.type !== "SWAP") continue;

    for (const transfer of tx.tokenTransfers ?? []) {
      if (transfer.mint !== token.address || transfer.tokenAmount <= 0) continue;

      let side: "buy" | "sell" | undefined;
      if (transfer.toUserAccount === tx.feePayer) side = "buy";
      else if (transfer.fromUserAccount === tx.feePayer) side = "sell";
      if (!side) continue;

      insertWalletActivity({
        walletAddress: tx.feePayer,
        tokenAddress: token.address,
        side,
        usdSize: transfer.tokenAmount * currentPriceUsd,
        txSignature: tx.signature,
      });
      recorded++;
    }
  }

  if (latestSignature) setLastTxSignature(token.address, latestSignature);
  return recorded;
}
