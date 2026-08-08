import { getRecentTokenTransactions } from "../data/helius.js";
import type { TokenConfig } from "../types/index.js";

export interface WhaleEvent {
  signature: string;
  side: "buy" | "sell";
  tokenAmount: number;
  usdSize: number;
  wallet: string;
  timestamp: number;
}

/**
 * Polls recent transactions involving the token's mint address (Helius returns
 * transaction history for any address, including mints) and flags SWAP
 * transactions moving more than `whaleUsdThreshold` of the token. `sinceSignature`
 * dedupes across polls -- pass the `latestSignature` from the previous call.
 */
export async function detectWhaleMoves(
  token: TokenConfig,
  currentPriceUsd: number,
  sinceSignature: string | undefined,
): Promise<{ events: WhaleEvent[]; latestSignature?: string }> {
  const txs = await getRecentTokenTransactions(token.address, { limit: 40 });
  if (txs.length === 0) return { events: [] };

  const latestSignature = txs[0]?.signature;
  const cutoffIdx = sinceSignature ? txs.findIndex((t) => t.signature === sinceSignature) : -1;
  const newTxs = cutoffIdx === -1 ? txs : txs.slice(0, cutoffIdx);

  const events: WhaleEvent[] = [];
  for (const tx of newTxs) {
    if (tx.type !== "SWAP") continue;

    for (const transfer of tx.tokenTransfers ?? []) {
      if (transfer.mint !== token.address) continue;

      const usdSize = transfer.tokenAmount * currentPriceUsd;
      if (usdSize < token.whaleUsdThreshold) continue;

      let side: "buy" | "sell" | undefined;
      if (transfer.toUserAccount === tx.feePayer) side = "buy";
      else if (transfer.fromUserAccount === tx.feePayer) side = "sell";
      if (!side) continue;

      events.push({
        signature: tx.signature,
        side,
        tokenAmount: transfer.tokenAmount,
        usdSize,
        wallet: tx.feePayer,
        timestamp: tx.timestamp,
      });
    }
  }

  return { events, latestSignature };
}
