import { getWalletBuysForTokenSince, type WalletActivityRow } from "../db/index.js";
import { checkWallet, type WalletCheckResult } from "./walletReputation.js";
import { areWalletsConnected } from "./walletConnectivity.js";
import type { TokenConfig, ConfluenceTier } from "../types/index.js";

export interface QualifyingCandidate {
  walletAddress: string;
  usdSize: number;
  txSignature: string;
  observedAt: string;
  check: WalletCheckResult;
}

export interface EntryTriggerResult {
  fired: boolean;
  tier?: ConfluenceTier;
  confirmingWallets: QualifyingCandidate[];
  candidatesConsidered: number;
  liquidityUsd: number;
  skipReason?: string;
}

/**
 * The required entry gate (Condition 7) -- on-chain confluence is the
 * strongest evidence this strategy has, not an optional add-on. A technical
 * setup with no qualifying on-chain confirmation never opens a position.
 *
 * Two ways to fire:
 *   Tier A: >= 2 qualifying wallets that are mutually unconnected (the
 *     connectivity check only runs when there are 2+ candidates -- there's
 *     nothing to compare a lone candidate against).
 *   Tier B: exactly 1 qualifying wallet, but it must additionally clear a
 *     raised bar (reputation >= neutral AND >= soloConfirmationMinPriorTrades
 *     prior trades) to compensate for having no independent corroboration.
 *
 * Takes the current liquidity as a param (the caller already fetched it
 * fresh for the entry-time re-check) rather than re-fetching it here.
 */
export async function evaluateEntryTrigger(token: TokenConfig, liquidityUsd: number): Promise<EntryTriggerResult> {
  const sinceIso = new Date(Date.now() - token.confirmationWindowHours * 60 * 60 * 1000).toISOString();
  const buys = getWalletBuysForTokenSince(token.address, sinceIso);

  if (buys.length === 0) {
    return {
      fired: false,
      confirmingWallets: [],
      candidatesConsidered: 0,
      liquidityUsd,
      skipReason: "no buys observed in confirmation window",
    };
  }

  const minBuyUsd = liquidityUsd * (token.minBuyPctOfLiquidity / 100);
  const maxBuyUsd = liquidityUsd * (token.maxBuyPctOfLiquidity / 100);
  const sizeQualified = buys.filter((b) => b.usd_size >= minBuyUsd && b.usd_size <= maxBuyUsd);

  if (sizeQualified.length === 0) {
    return {
      fired: false,
      confirmingWallets: [],
      candidatesConsidered: buys.length,
      liquidityUsd,
      skipReason: `no buys in qualifying size range [$${minBuyUsd.toFixed(0)}, $${maxBuyUsd.toFixed(0)}] (${token.minBuyPctOfLiquidity}-${token.maxBuyPctOfLiquidity}% of $${liquidityUsd.toFixed(0)} liquidity)`,
    };
  }

  // One candidate per wallet -- if a wallet bought more than once in the
  // window, that's still only one independent voice, not two.
  const latestBuyByWallet = new Map<string, WalletActivityRow>();
  for (const buy of sizeQualified) latestBuyByWallet.set(buy.wallet_address, buy);

  const qualifying: QualifyingCandidate[] = [];
  for (const buy of latestBuyByWallet.values()) {
    const check = await checkWallet(buy.wallet_address, token.minWalletAgeDays, token.minWalletPriorTrades);
    if (check.passesAgeAndHistory && check.passesReputation) {
      qualifying.push({
        walletAddress: buy.wallet_address,
        usdSize: buy.usd_size,
        txSignature: buy.tx_signature,
        observedAt: buy.observed_at,
        check,
      });
    }
  }

  if (qualifying.length === 0) {
    return {
      fired: false,
      confirmingWallets: [],
      candidatesConsidered: buys.length,
      liquidityUsd,
      skipReason: `no qualifying wallets (need age>=${token.minWalletAgeDays}d, priorTrades>=${token.minWalletPriorTrades}, no observed dumps)`,
    };
  }

  // Mutual-unconnectedness only matters -- and only runs -- when there's
  // more than one candidate to compare. A lone candidate has nothing to be
  // "connected" to at this stage.
  let confirmed: QualifyingCandidate[];
  if (qualifying.length === 1) {
    confirmed = qualifying;
  } else {
    confirmed = [];
    for (const candidate of qualifying) {
      let connectedToExisting = false;
      for (const existing of confirmed) {
        if (await areWalletsConnected(candidate.walletAddress, existing.walletAddress)) {
          connectedToExisting = true;
          break;
        }
      }
      if (!connectedToExisting) confirmed.push(candidate);
      if (confirmed.length >= 2) break; // Tier A is already secured -- no need to keep checking
    }
  }

  if (confirmed.length < token.minConfirmingWallets) {
    return {
      fired: false,
      confirmingWallets: confirmed,
      candidatesConsidered: buys.length,
      liquidityUsd,
      skipReason: `only ${confirmed.length} confirming wallet(s) after connectivity check, need >=${token.minConfirmingWallets}`,
    };
  }

  if (confirmed.length >= 2) {
    return { fired: true, tier: "A", confirmingWallets: confirmed, candidatesConsidered: buys.length, liquidityUsd };
  }

  // Exactly 1 -- solo confirmation needs the raised bar.
  const solo = confirmed[0];
  const soloPasses = solo.check.reputationScore >= 0 && solo.check.historyTxCount >= token.soloConfirmationMinPriorTrades;
  if (!soloPasses) {
    return {
      fired: false,
      confirmingWallets: confirmed,
      candidatesConsidered: buys.length,
      liquidityUsd,
      skipReason: `solo confirming wallet doesn't clear the raised Tier B bar (needs reputation>=0 and >=${token.soloConfirmationMinPriorTrades} prior trades; has ${solo.check.reputationScore.toFixed(2)} / ${solo.check.historyTxCount})`,
    };
  }

  return { fired: true, tier: "B", confirmingWallets: confirmed, candidatesConsidered: buys.length, liquidityUsd };
}
