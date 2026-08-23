import { test } from "node:test";
import assert from "node:assert/strict";
import { computeConfidenceScore } from "./scoring.js";
import type { SellTimingComparison } from "./types.js";

function timing(candidateSoldSooner: boolean | null): SellTimingComparison {
  return {
    tokenAddress: "T",
    tokenSymbol: "TKN",
    candidateHoldMinutes: candidateSoldSooner == null ? null : 10,
    mainWalletHoldMinutes: candidateSoldSooner == null ? null : 20,
    candidateSoldSooner,
  };
}

test("computeConfidenceScore: minimum overlap alone with no other evidence scores low", () => {
  const { score, band } = computeConfidenceScore({
    overlapCount: 4, // the module's own conservative default minOverlapCount
    fundingLinkHopDistance: null,
    sellTiming: [],
    feePayerOverlapFound: false,
  });
  assert.equal(band, "low");
  assert.ok(score < 40, `expected low score, got ${score}`);
});

test("computeConfidenceScore: overlap count is the dominant factor -- more overlap strictly increases score, all else equal", () => {
  const low = computeConfidenceScore({ overlapCount: 4, fundingLinkHopDistance: null, sellTiming: [], feePayerOverlapFound: false });
  const high = computeConfidenceScore({ overlapCount: 10, fundingLinkHopDistance: null, sellTiming: [], feePayerOverlapFound: false });
  assert.ok(high.score > low.score);
});

test("computeConfidenceScore: a direct funding link multiplies the score, doesn't just add a flat amount", () => {
  const withoutLink = computeConfidenceScore({ overlapCount: 6, fundingLinkHopDistance: null, sellTiming: [], feePayerOverlapFound: false });
  const withDirectLink = computeConfidenceScore({ overlapCount: 6, fundingLinkHopDistance: 1, sellTiming: [], feePayerOverlapFound: false });
  const withSharedLink = computeConfidenceScore({ overlapCount: 6, fundingLinkHopDistance: 2, sellTiming: [], feePayerOverlapFound: false });

  assert.ok(withDirectLink.score > withSharedLink.score, "direct link should score higher than a shared-intermediary link");
  assert.ok(withSharedLink.score > withoutLink.score, "any funding link should score higher than none");
  // multiplier check: the ratio should roughly match the documented 1.4x for a direct link
  assert.ok(Math.abs(withDirectLink.score / withoutLink.score - 1.4) < 0.05);
});

test("computeConfidenceScore: high overlap + direct funding link reaches the high band", () => {
  const { band } = computeConfidenceScore({ overlapCount: 10, fundingLinkHopDistance: 1, sellTiming: [], feePayerOverlapFound: false });
  assert.equal(band, "high");
});

test("computeConfidenceScore: sell-timing and fee-payer bonuses are minor -- neither alone flips a low-overlap candidate to high", () => {
  const { score, band } = computeConfidenceScore({
    overlapCount: 4,
    fundingLinkHopDistance: null,
    sellTiming: [timing(true), timing(true), timing(true)],
    feePayerOverlapFound: true,
  });
  assert.notEqual(band, "high");
  assert.ok(score < 40, `expected the minor bonuses to still leave this in "low", got ${score}`);
});

test("computeConfidenceScore: sell-timing pattern only counts comparable (non-null) data points", () => {
  const majoritySooner = computeConfidenceScore({
    overlapCount: 6,
    fundingLinkHopDistance: null,
    sellTiming: [timing(true), timing(true), timing(null), timing(null)], // 2/2 comparable say "sooner"
    feePayerOverlapFound: false,
  });
  const noComparableData = computeConfidenceScore({
    overlapCount: 6,
    fundingLinkHopDistance: null,
    sellTiming: [timing(null), timing(null)],
    feePayerOverlapFound: false,
  });
  assert.ok(majoritySooner.score > noComparableData.score);
});

test("computeConfidenceScore: score is always clamped to [0, 100]", () => {
  const { score } = computeConfidenceScore({
    overlapCount: 1000,
    fundingLinkHopDistance: 1,
    sellTiming: [timing(true)],
    feePayerOverlapFound: true,
  });
  assert.ok(score <= 100);
});
