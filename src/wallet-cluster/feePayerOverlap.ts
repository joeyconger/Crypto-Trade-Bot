import { getRecentTransactions, type HeliusTransaction } from "../data/helius.js";

const PAGE_LIMIT = 100;

/** Distinct fee payers seen on this wallet's recent transactions where the fee payer ISN'T the wallet itself -- someone else covering its gas is the interesting signal (a common sockpuppet-funding tell). */
async function externalFeePayersFor(wallet: string): Promise<Set<string>> {
  const txs = await getRecentTransactions(wallet, { limit: PAGE_LIMIT });
  const payers = new Set<string>();
  for (const tx of txs as HeliusTransaction[]) {
    if (tx.feePayer && tx.feePayer !== wallet) payers.add(tx.feePayer);
  }
  return payers;
}

export interface FeePayerOverlapResult {
  checked: boolean;
  found: boolean;
  detail?: string;
}

/**
 * Checks whether the candidate and main wallet share a fee payer -- either
 * directly (one paid gas for the other) or via a common third-party payer
 * (e.g. both funded/gas-sponsored from the same bot-runner wallet). Helius's
 * enhanced-transaction shape always includes feePayer (data/helius.ts's
 * HeliusTransaction has it as a required field), so `checked` is always true
 * for this data source -- the field exists purely so this module's output
 * doesn't silently omit the check if a future data source lacks it, per the
 * guardrail against silent omission.
 */
export async function checkFeePayerOverlap(candidateWallet: string, mainWallet: string): Promise<FeePayerOverlapResult> {
  const [candidatePayers, mainPayers] = await Promise.all([
    externalFeePayersFor(candidateWallet),
    externalFeePayersFor(mainWallet),
  ]);

  if (candidatePayers.has(mainWallet)) {
    return { checked: true, found: true, detail: `main wallet directly paid a fee for the candidate's transaction` };
  }
  if (mainPayers.has(candidateWallet)) {
    return { checked: true, found: true, detail: `candidate directly paid a fee for the main wallet's transaction` };
  }
  for (const payer of candidatePayers) {
    if (mainPayers.has(payer)) {
      return { checked: true, found: true, detail: `both wallets had transactions fee-paid by ${payer}` };
    }
  }

  return { checked: true, found: false };
}
