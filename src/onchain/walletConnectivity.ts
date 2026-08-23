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

/** Every address a wallet has sent to or received from directly, from its own recent (bounded) history -- its "1-hop neighborhood." */
async function directCounterparties(wallet: string, limit = 100): Promise<Set<string>> {
  const txs = await getRecentTransactions(wallet, { limit });
  const counterparties = new Set<string>();
  for (const tx of txs) {
    for (const t of [...(tx.nativeTransfers ?? []), ...(tx.tokenTransfers ?? [])]) {
      if (t.fromUserAccount === wallet && t.toUserAccount) counterparties.add(t.toUserAccount);
      if (t.toUserAccount === wallet && t.fromUserAccount) counterparties.add(t.fromUserAccount);
    }
  }
  counterparties.delete(wallet);
  return counterparties;
}

export interface FundingLinkResult {
  connected: boolean;
  hopDistance: 1 | 2 | null; // 1 = direct transfer either direction; 2 = shared one-hop counterparty (common funder/payee); null = no link found within 2 hops
  sharedIntermediary?: string; // only set for hopDistance 2 -- which wallet both A and B transacted with
}

/**
 * Extends areWalletsConnected (kept unchanged above -- src/onchain/entryTrigger.ts
 * depends on its exact direct-only behavior for the live/paper strategy's
 * Tier A mutual-independence check, so this is purely additive, never a
 * replacement) with a second hop: two wallets also count as linked if they
 * each directly transacted with some THIRD wallet in common (e.g. both
 * funded from the same source, or both paid out to the same destination).
 * Still a heuristic on a bounded, recent transaction window per wallet --
 * not a full graph walk, not proof of common control, just a stronger
 * correlation signal than the direct-only check alone.
 */
export async function findFundingLink(walletA: string, walletB: string): Promise<FundingLinkResult> {
  const [neighborsA, neighborsB] = await Promise.all([directCounterparties(walletA), directCounterparties(walletB)]);

  if (neighborsA.has(walletB) || neighborsB.has(walletA)) {
    return { connected: true, hopDistance: 1 };
  }

  for (const shared of neighborsA) {
    if (neighborsB.has(shared)) {
      return { connected: true, hopDistance: 2, sharedIntermediary: shared };
    }
  }

  return { connected: false, hopDistance: null };
}
