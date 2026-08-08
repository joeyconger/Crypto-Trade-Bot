import { getWalletBuysForTokenSince, type WalletActivityRow } from "../db/index.js";
import { checkWallet, type WalletCheckResult } from "./walletReputation.js";
import { areWalletsConnected } from "./walletConnectivity.js";
import type { TokenConfig } from "../types/index.js";

export interface QualifyingCandidate {
  walletAddress: string;
  usdSize: number;
  txSignature: string;
  observedAt: string;
  check: WalletCheckResult;
}

export interface EntryTriggerResult {
  fired: boolean;
  confirmingWallets: QualifyingCandidate[];
  candidatesConsidered: number;
  liquidityUsd: number;
  skipReason?: string;
}

/**
 * The only signal that can trigger an entry. Requires >=minConfirmingWallets
 * separate, mutually-unconnected wallets to each independently pass the
 * per-wallet qualifying filters (size vs. liquidity, age/history, tag,
 * reputation) within the confirmation window. One wallet alone never fires
 * this, no matter how well it qualifies. Takes the current liquidity as a
 * param (the caller already fetched it alongside price) rather than
 * re-fetching from Birdeye here.
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

  const maxBuyUsd = liquidityUsd * (token.maxBuyPctOfLiquidity / 100);
  const sizeQualified = buys.filter((b) => b.usd_size >= token.minBuyUsd && b.usd_size <= maxBuyUsd);

  if (sizeQualified.length === 0) {
    return {
      fired: false,
      confirmingWallets: [],
      candidatesConsidered: buys.length,
      liquidityUsd,
      skipReason: `no buys in qualifying size range [$${token.minBuyUsd}, $${maxBuyUsd.toFixed(0)}] (${token.maxBuyPctOfLiquidity}% of $${liquidityUsd.toFixed(0)} liquidity)`,
    };
  }

  // One candidate per wallet -- if a wallet bought more than once in the
  // window, that's still only one independent voice, not two.
  const latestBuyByWallet = new Map<string, WalletActivityRow>();
  for (const buy of sizeQualified) latestBuyByWallet.set(buy.wallet_address, buy);

  const qualifying: QualifyingCandidate[] = [];
  for (const buy of latestBuyByWallet.values()) {
    const check = await checkWallet(buy.wallet_address, token.minWalletAgeDays, token.minWalletPriorTrades);
    if (check.passesAgeAndHistory && check.passesTag && check.passesReputation) {
      qualifying.push({
        walletAddress: buy.wallet_address,
        usdSize: buy.usd_size,
        txSignature: buy.tx_signature,
        observedAt: buy.observed_at,
        check,
      });
    }
  }

  if (qualifying.length < token.minConfirmingWallets) {
    return {
      fired: false,
      confirmingWallets: qualifying,
      candidatesConsidered: buys.length,
      liquidityUsd,
      skipReason: `only ${qualifying.length} qualifying wallet(s), need ${token.minConfirmingWallets}`,
    };
  }

  // Greedily build a mutually-unconnected confirming set, stopping as soon as
  // it's big enough -- bounds the number of connectivity-check API calls.
  const confirmed: QualifyingCandidate[] = [];
  for (const candidate of qualifying) {
    let connectedToExisting = false;
    for (const existing of confirmed) {
      if (await areWalletsConnected(candidate.walletAddress, existing.walletAddress)) {
        connectedToExisting = true;
        break;
      }
    }
    if (!connectedToExisting) confirmed.push(candidate);
    if (confirmed.length >= token.minConfirmingWallets) break;
  }

  if (confirmed.length < token.minConfirmingWallets) {
    return {
      fired: false,
      confirmingWallets: confirmed,
      candidatesConsidered: buys.length,
      liquidityUsd,
      skipReason: `only ${confirmed.length} mutually-independent wallet(s) after connectivity check, need ${token.minConfirmingWallets}`,
    };
  }

  return { fired: true, confirmingWallets: confirmed, candidatesConsidered: buys.length, liquidityUsd };
}
