import { findFundingLink } from "../onchain/walletConnectivity.js";
import { fetchMainWalletTrades } from "./fetchMainWalletTrades.js";
import { fetchPreBuyWindow } from "./fetchPreBuyWindow.js";
import { fetchWalletTradeForToken } from "./fetchWalletTradeForToken.js";
import { checkFeePayerOverlap } from "./feePayerOverlap.js";
import { computeConfidenceScore } from "./scoring.js";
import { saveWalletClusterRun } from "./db.js";
import type {
  MainWalletTrade,
  CandidateResult,
  TokenOverlap,
  SellTimingComparison,
  WalletClusterConfig,
  WalletClusterRunResult,
} from "./types.js";

// Below this many independent tokens in the sample, overlap counts stop
// being meaningful even relative to minOverlapCount's own conservative
// default -- 4 overlaps out of 5 total tokens analyzed is a completely
// different statement than 4 out of 15.
const MIN_SAMPLE_SIZE = 5;
// If the whole sample's buys are crammed into a narrow window, "independent
// tokens" is a weaker claim -- a bot sniping every launch in a busy hour
// looks identical to a wallet specifically tracking the main wallet.
const MIN_SAMPLE_SPAN_HOURS = 6;

function assessSampleQuality(trades: MainWalletTrade[]): { tooThin: boolean; note?: string } {
  if (trades.length < MIN_SAMPLE_SIZE) {
    return {
      tooThin: true,
      note: `Only ${trades.length} token(s) in the sample (fewer than ${MIN_SAMPLE_SIZE}) -- overlap counts below are not statistically meaningful at this sample size, regardless of what they show.`,
    };
  }

  const times = trades.map((t) => new Date(t.buyAt).getTime());
  const spanHours = (Math.max(...times) - Math.min(...times)) / (1000 * 60 * 60);
  if (spanHours < MIN_SAMPLE_SPAN_HOURS) {
    return {
      tooThin: true,
      note: `The ${trades.length} sampled buys all fall within a ${spanHours.toFixed(1)}-hour window -- too clustered in time to distinguish "consistently tracks this wallet across independent tokens" from "a bot sniping every launch in a busy stretch."`,
    };
  }

  return { tooThin: false };
}

async function buildSellTiming(
  candidateWallet: string,
  overlapTokens: TokenOverlap[],
  mainTradeByToken: Map<string, MainWalletTrade>,
): Promise<SellTimingComparison[]> {
  const comparisons: SellTimingComparison[] = [];

  for (const overlap of overlapTokens) {
    const mainTrade = mainTradeByToken.get(overlap.tokenAddress);
    const candidateTrade = await fetchWalletTradeForToken(candidateWallet, overlap.tokenAddress);

    const mainWalletHoldMinutes =
      mainTrade?.sellAt != null
        ? (new Date(mainTrade.sellAt).getTime() - new Date(mainTrade.buyAt).getTime()) / 60000
        : null;
    const candidateHoldMinutes =
      candidateTrade.buyAt && candidateTrade.sellAt
        ? (new Date(candidateTrade.sellAt).getTime() - new Date(candidateTrade.buyAt).getTime()) / 60000
        : null;

    comparisons.push({
      tokenAddress: overlap.tokenAddress,
      tokenSymbol: overlap.tokenSymbol,
      candidateHoldMinutes,
      mainWalletHoldMinutes,
      candidateSoldSooner:
        candidateHoldMinutes != null && mainWalletHoldMinutes != null ? candidateHoldMinutes < mainWalletHoldMinutes : null,
    });
  }

  return comparisons;
}

export interface RunWalletClusterPipelineOptions {
  mainWallet: string;
  config: WalletClusterConfig;
  onProgress?: (message: string) => void;
}

export async function runWalletClusterPipeline(options: RunWalletClusterPipelineOptions): Promise<WalletClusterRunResult> {
  const { mainWallet, config, onProgress } = options;
  const log = onProgress ?? (() => {});

  log(`Fetching ${mainWallet}'s recent trade history (up to ${config.maxTokensToAnalyze} tokens)...`);
  const tokensAnalyzed = await fetchMainWalletTrades(mainWallet, config.maxTokensToAnalyze);
  const mainTradeByToken = new Map(tokensAnalyzed.map((t) => [t.tokenAddress, t]));

  const { tooThin, note } = assessSampleQuality(tokensAnalyzed);
  if (tooThin) log(`WARNING: ${note}`);

  if (tokensAnalyzed.length === 0) {
    return {
      mainWallet,
      runAt: new Date().toISOString(),
      preBuyWindowMinutes: config.preBuyWindowMinutes,
      minOverlapCount: config.minOverlapCount,
      tokensAnalyzed: [],
      sampleTooThin: true,
      sampleNote: "No buys found in this wallet's recent transaction history -- nothing to analyze.",
      candidates: [],
    };
  }

  // ---- Step 2+3: pre-buy-window early buyers per token, aggregated by candidate wallet ----
  const overlapsByCandidate = new Map<string, TokenOverlap[]>();
  for (const trade of tokensAnalyzed) {
    log(`Scanning early buyers of ${trade.tokenSymbol} in the ${config.preBuyWindowMinutes}min before the main wallet's buy...`);
    const { earlyBuyers, truncated, pagesScanned } = await fetchPreBuyWindow(
      trade.tokenAddress,
      trade.buyAt,
      config.preBuyWindowMinutes,
    );
    if (truncated) {
      log(
        `  NOTE: ${trade.tokenSymbol}'s early-buyer scan hit its page cap (${pagesScanned} pages) before fully covering the window -- coverage for this token may be incomplete.`,
      );
    }
    for (const buyer of earlyBuyers) {
      if (buyer.walletAddress === mainWallet) continue;
      const list = overlapsByCandidate.get(buyer.walletAddress) ?? [];
      list.push({
        tokenAddress: trade.tokenAddress,
        tokenSymbol: trade.tokenSymbol,
        candidateBuyAt: buyer.buyAt,
        mainWalletBuyAt: trade.buyAt,
        minutesBeforeMainBuy: buyer.minutesBeforeMainBuy,
      });
      overlapsByCandidate.set(buyer.walletAddress, list);
    }
  }

  // ---- Step 3: rank by overlap count, drop anything below minOverlapCount ----
  const aboveThreshold = [...overlapsByCandidate.entries()]
    .filter(([, tokens]) => tokens.length >= config.minOverlapCount)
    .sort((a, b) => b[1].length - a[1].length);

  log(`${aboveThreshold.length} candidate wallet(s) at or above minOverlapCount=${config.minOverlapCount}.`);

  // ---- Step 4: secondary evidence, per surviving candidate ----
  const candidates: CandidateResult[] = [];
  for (const [candidateWallet, overlapTokens] of aboveThreshold) {
    log(`Gathering evidence for ${candidateWallet} (${overlapTokens.length} token overlap)...`);

    let fundingLinkChecked = true;
    let fundingLinkFound = false;
    let fundingLinkHopDistance: 1 | 2 | null = null;
    let fundingLinkDetail: string | undefined;
    try {
      const link = await findFundingLink(candidateWallet, mainWallet);
      fundingLinkFound = link.connected;
      fundingLinkHopDistance = link.hopDistance;
      fundingLinkDetail = link.sharedIntermediary ? `shared intermediary: ${link.sharedIntermediary}` : undefined;
    } catch (err) {
      fundingLinkChecked = false;
    }

    let sellTimingChecked = true;
    let sellTiming: SellTimingComparison[] = [];
    try {
      sellTiming = await buildSellTiming(candidateWallet, overlapTokens, mainTradeByToken);
    } catch {
      sellTimingChecked = false;
    }

    let feePayerChecked = true;
    let feePayerOverlapFound = false;
    let feePayerOverlapDetail: string | undefined;
    try {
      const feeResult = await checkFeePayerOverlap(candidateWallet, mainWallet);
      feePayerChecked = feeResult.checked;
      feePayerOverlapFound = feeResult.found;
      feePayerOverlapDetail = feeResult.detail;
    } catch {
      feePayerChecked = false;
    }

    const dataGaps: string[] = [];
    if (!fundingLinkChecked) dataGaps.push("funding-link check failed (provider error) -- not reported as absent, genuinely unknown");
    if (!sellTimingChecked) dataGaps.push("sell-timing check failed (provider error) -- not reported as absent, genuinely unknown");
    if (!feePayerChecked) dataGaps.push("fee-payer check failed (provider error) -- not reported as absent, genuinely unknown");

    const { score, band } = computeConfidenceScore({
      overlapCount: overlapTokens.length,
      fundingLinkHopDistance,
      sellTiming,
      feePayerOverlapFound,
    });

    const suggestedForExclusion =
      overlapTokens.length >= config.exclusionSuggestionMinOverlap &&
      (!config.exclusionSuggestionRequireFundingLink || fundingLinkFound);

    candidates.push({
      candidateWallet,
      overlapCount: overlapTokens.length,
      overlapTokens,
      fundingLinkChecked,
      fundingLinkFound,
      fundingLinkHopDistance,
      fundingLinkDetail,
      sellTimingChecked,
      sellTiming,
      feePayerChecked,
      feePayerOverlapFound,
      feePayerOverlapDetail,
      dataGapsNote: dataGaps.length > 0 ? dataGaps.join("; ") : undefined,
      confidenceScore: score,
      confidenceBand: band,
      suggestedForExclusion,
    });
  }

  candidates.sort((a, b) => b.confidenceScore - a.confidenceScore);

  const result: WalletClusterRunResult = {
    mainWallet,
    runAt: new Date().toISOString(),
    preBuyWindowMinutes: config.preBuyWindowMinutes,
    minOverlapCount: config.minOverlapCount,
    tokensAnalyzed,
    sampleTooThin: tooThin,
    sampleNote: note,
    candidates,
  };

  const runId = saveWalletClusterRun(result);
  log(`Run ${runId} saved: ${candidates.length} candidate(s) found.`);

  return result;
}
