import type { ConfidenceBand, SellTimingComparison } from "./types.js";

/**
 * Confidence-score weighting for wallet-clustering candidates. THIS IS A
 * JUDGMENT CALL, not a formula calibrated against ground truth -- there is
 * no labeled dataset of "actually the same trader's side wallet" to tune
 * against, so these weights encode a defensible ordering of evidence
 * strength, not a precise probability. A high score means "consistent with
 * being a controlled wallet," never "confirmed" -- see README.
 *
 * Design, per the brief's explicit priority ordering:
 *
 *   1. Overlap count is THE dominant signal. A wallet that keeps buying
 *      right before the main wallet, across many INDEPENDENT tokens, is
 *      much harder to explain by coincidence than any single piece of
 *      secondary evidence -- bots/snipers hit any one launch by chance
 *      constantly, but hitting the same wallet's launches repeatedly is a
 *      real pattern. Scaled linearly from 0 up to a saturation point
 *      (OVERLAP_SATURATION_COUNT), contributing up to OVERLAP_MAX_POINTS.
 *
 *   2. A funding link is a MULTIPLIER on the overlap-based score, not a flat
 *      addition -- it means "and there's a plausible mechanical reason for
 *      the correlation," which should scale the strength of whatever
 *      overlap evidence already exists rather than being worth the same
 *      fixed amount regardless of how much overlap evidence backs it. Direct
 *      (1-hop) links multiply harder than a shared-intermediary (2-hop)
 *      link, since the latter is easier to hit by coincidence (e.g. both
 *      wallets happening to use the same CEX withdrawal hot wallet).
 *
 *   3. Sell-timing pattern and fee-payer overlap are MINOR corroborating
 *      factors -- small, capped additive bonuses applied after the
 *      multiplier, deliberately small enough that neither can single-
 *      handedly push a low-overlap candidate into "high" confidence.
 */

const OVERLAP_SATURATION_COUNT = 10; // overlap counts at/above this get the full base score
const OVERLAP_MAX_POINTS = 70;

const FUNDING_LINK_MULTIPLIER_DIRECT = 1.4; // hop distance 1
const FUNDING_LINK_MULTIPLIER_SHARED = 1.2; // hop distance 2
const FUNDING_LINK_MULTIPLIER_NONE = 1.0;

const SELL_TIMING_BONUS = 5;
const FEE_PAYER_BONUS = 5;

const HIGH_CONFIDENCE_THRESHOLD = 70;
const MODERATE_CONFIDENCE_THRESHOLD = 40;

export interface ScoringInput {
  overlapCount: number;
  fundingLinkHopDistance: 1 | 2 | null;
  sellTiming: SellTimingComparison[];
  feePayerOverlapFound: boolean;
}

export interface ScoringResult {
  score: number; // 0-100
  band: ConfidenceBand;
}

// How soon after the main wallet's buy a candidate's sell still counts as
// "cashed out on the pump" rather than an unrelated, much-later exit. A
// judgment call, same as everything else in this file -- 3 hours is
// generous enough to cover a slower exit than an instant flip, without
// counting "sold two weeks later" as the same pattern.
const QUICK_EXIT_WINDOW_MINUTES = 180;

/**
 * True when a majority of the comparable tokens support "bought ahead of
 * the main wallet, sold once the main wallet's buy likely pumped it."
 * Prefers minutesFromMainWalletBuyToCandidateSell (computable as soon as the
 * candidate has ANY observed sell) over candidateSoldSooner (needs the main
 * wallet to have ALSO sold, which is often unavailable -- in this module's
 * first real test run, unavailable for every single candidate). Falls back
 * to candidateSoldSooner per-token only where the primary signal is missing.
 * Tokens where NEITHER signal is available are excluded from the vote
 * entirely, never treated as "no."
 */
function sellTimingSupportsPattern(sellTiming: SellTimingComparison[]): boolean {
  const votes = sellTiming
    .map((s) => {
      if (s.minutesFromMainWalletBuyToCandidateSell != null) {
        return s.minutesFromMainWalletBuyToCandidateSell <= QUICK_EXIT_WINDOW_MINUTES;
      }
      return s.candidateSoldSooner;
    })
    .filter((v): v is boolean => v !== null);

  if (votes.length === 0) return false;
  return votes.filter(Boolean).length / votes.length > 0.5;
}

export function computeConfidenceScore(input: ScoringInput): ScoringResult {
  const overlapBase = Math.min(1, input.overlapCount / OVERLAP_SATURATION_COUNT) * OVERLAP_MAX_POINTS;

  const fundingMultiplier =
    input.fundingLinkHopDistance === 1
      ? FUNDING_LINK_MULTIPLIER_DIRECT
      : input.fundingLinkHopDistance === 2
        ? FUNDING_LINK_MULTIPLIER_SHARED
        : FUNDING_LINK_MULTIPLIER_NONE;

  let score = overlapBase * fundingMultiplier;

  if (sellTimingSupportsPattern(input.sellTiming)) score += SELL_TIMING_BONUS;
  if (input.feePayerOverlapFound) score += FEE_PAYER_BONUS;

  score = Math.max(0, Math.min(100, score));

  const band: ConfidenceBand =
    score >= HIGH_CONFIDENCE_THRESHOLD ? "high" : score >= MODERATE_CONFIDENCE_THRESHOLD ? "moderate" : "low";

  return { score, band };
}
