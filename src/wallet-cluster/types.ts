// Shared types for the wallet-clustering analysis pipeline. Everything here
// is READ-ONLY analysis output -- nothing in this module places trades or
// writes to the main strategy's or wallet-tail's tables. See schema.sql for
// the persisted shape; these are the in-memory equivalents used while a run
// is being computed.

export interface MainWalletTrade {
  tokenAddress: string;
  tokenSymbol: string;
  buyAt: string; // ISO -- on-chain timestamp of the main wallet's buy
  buyTxSignature: string;
  sellAt?: string; // ISO, if the main wallet has since sold this token
  sellTxSignature?: string;
}

export interface EarlyBuyer {
  walletAddress: string;
  buyAt: string; // ISO
  minutesBeforeMainBuy: number;
  sellAt?: string; // ISO, if this wallet has since sold
}

export interface TokenOverlap {
  tokenAddress: string;
  tokenSymbol: string;
  candidateBuyAt: string;
  mainWalletBuyAt: string;
  minutesBeforeMainBuy: number;
}

export interface SellTimingComparison {
  tokenAddress: string;
  tokenSymbol: string;
  candidateHoldMinutes: number | null; // null if the candidate hasn't sold yet (or sell wasn't observed)
  mainWalletHoldMinutes: number | null; // null if the main wallet hasn't sold yet
  candidateSoldSooner: boolean | null; // null when either hold time is unavailable -- never guessed
}

export type ConfidenceBand = "low" | "moderate" | "high";

export interface CandidateResult {
  candidateWallet: string;
  overlapCount: number;
  overlapTokens: TokenOverlap[];

  fundingLinkChecked: boolean;
  fundingLinkFound: boolean;
  fundingLinkHopDistance: 1 | 2 | null;
  fundingLinkDetail?: string;

  sellTimingChecked: boolean;
  sellTiming: SellTimingComparison[];

  feePayerChecked: boolean;
  feePayerOverlapFound: boolean;
  feePayerOverlapDetail?: string;

  dataGapsNote?: string;

  confidenceScore: number; // 0-100
  confidenceBand: ConfidenceBand;
  suggestedForExclusion: boolean;
}

export interface WalletClusterRunResult {
  mainWallet: string;
  runAt: string;
  preBuyWindowMinutes: number;
  minOverlapCount: number;
  tokensAnalyzed: MainWalletTrade[];
  sampleTooThin: boolean;
  sampleNote?: string;
  candidates: CandidateResult[];
}

export interface WalletClusterConfig {
  preBuyWindowMinutes: number;
  minOverlapCount: number;
  // A candidate is suggested for the exclusion-list review queue only when
  // it clears BOTH bars -- overlap alone is too easy to hit by coincidence
  // (shared bots/snipers), and a funding link alone (e.g. a CEX withdrawal
  // wallet) doesn't establish a trading-pattern relationship. See
  // scoring.ts for the full confidence-score weighting this sits on top of.
  exclusionSuggestionMinOverlap: number;
  exclusionSuggestionRequireFundingLink: boolean;
  maxTokensToAnalyze: number; // bound on auto-fetched main-wallet trade history
}

export const DEFAULT_WALLET_CLUSTER_CONFIG: WalletClusterConfig = {
  preBuyWindowMinutes: 60,
  minOverlapCount: 4,
  exclusionSuggestionMinOverlap: 6,
  exclusionSuggestionRequireFundingLink: true,
  maxTokensToAnalyze: 15,
};
