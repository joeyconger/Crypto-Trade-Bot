import { getRecentTransactions } from "../data/helius.js";

// Filters out fee-sized SOL transfers from counting as a "counterparty" for
// findFundingLink below -- confirmed as a real false-positive source by a
// live run: a shared hop-2 "link" between two unrelated wallets turned out
// to just be both of them routing a trade fee through the same platform fee
// wallet, not any actual relationship. A genuine funding transfer (seeding
// a wallet with gas/rent) is near-universally at least this much in
// practice; this won't catch fee routing on a very large trade, but it
// removes the specific dust-fee pattern that was observed. Deliberately
// only applied to native SOL transfers (the dominant funding mechanism) --
// token transfers aren't filtered, so a similar false positive via a
// token-denominated fee route is still possible.
const MIN_LAMPORTS_FOR_FUNDING_LINK = 10_000_000; // 0.01 SOL

/** Every address a wallet has sent to or received from directly (above the dust-fee floor for native transfers), from its own recent (bounded) history -- its "1-hop neighborhood." */
async function directCounterparties(wallet: string, limit = 100): Promise<Set<string>> {
  const txs = await getRecentTransactions(wallet, { limit });
  const counterparties = new Set<string>();
  for (const tx of txs) {
    for (const t of tx.nativeTransfers ?? []) {
      if (t.amount < MIN_LAMPORTS_FOR_FUNDING_LINK) continue;
      if (t.fromUserAccount === wallet && t.toUserAccount) counterparties.add(t.toUserAccount);
      if (t.toUserAccount === wallet && t.fromUserAccount) counterparties.add(t.fromUserAccount);
    }
    for (const t of tx.tokenTransfers ?? []) {
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
 * Two wallets count as linked either directly (one has sent SOL/a token to
 * the other, above the dust-fee floor above) or via a second hop: each
 * directly transacted with some THIRD wallet in common (e.g. both funded
 * from the same source, or both paid out to the same destination). Still a
 * heuristic on a bounded, recent transaction window per wallet -- not a
 * full graph walk, not proof of common control, just a correlation signal.
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
