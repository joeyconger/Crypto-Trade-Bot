import { getRecentTransactions, type HeliusTransaction } from "../data/helius.js";

function transactedDirectly(tx: HeliusTransaction, walletA: string, walletB: string): boolean {
  const touchesPair = (from: string | undefined, to: string | undefined) =>
    (from === walletA && to === walletB) || (from === walletB && to === walletA);

  return (
    (tx.nativeTransfers ?? []).some((t) => touchesPair(t.fromUserAccount, t.toUserAccount)) ||
    (tx.tokenTransfers ?? []).some((t) => touchesPair(t.fromUserAccount, t.toUserAccount))
  );
}

/**
 * Heuristic only, not exhaustive collusion detection: two wallets count as
 * "connected" if either has directly sent SOL or a token to the other
 * (a classic tell for sockpuppet wallets -- one funds the other's gas)
 * anywhere in walletA's recent history. True common-funding analysis (a
 * shared original funding source several hops back) needs a much deeper
 * transaction-graph walk than a free-tier API budget supports -- this
 * catches the direct/obvious case, not a laundered one.
 */
export async function areWalletsConnected(walletA: string, walletB: string): Promise<boolean> {
  const txs = await getRecentTransactions(walletA, { limit: 100 });
  return txs.some((tx) => transactedDirectly(tx, walletA, walletB));
}
