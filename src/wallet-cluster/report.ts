import type { WalletClusterRunResult, CandidateResult } from "./types.js";

function pct(n: number | null): string {
  return n == null ? "n/a" : `${n.toFixed(0)}min`;
}

function candidateBlock(c: CandidateResult, index: number): string {
  const lines: string[] = [];
  lines.push(`#${index + 1}  ${c.candidateWallet}`);
  lines.push(
    `  confidence: ${c.confidenceScore.toFixed(1)}/100 (${c.confidenceBand.toUpperCase()}) -- consistent with a controlled wallet, NOT confirmed`,
  );
  lines.push(`  overlap: ${c.overlapCount} token(s) -- ${c.overlapTokens.map((t) => t.tokenSymbol).join(", ")}`);
  for (const t of c.overlapTokens) {
    lines.push(`    - ${t.tokenSymbol}: bought ${t.minutesBeforeMainBuy.toFixed(1)}min before the main wallet`);
  }

  if (!c.fundingLinkChecked) {
    lines.push(`  funding link: UNKNOWN (check failed -- see data gaps)`);
  } else {
    lines.push(
      `  funding link: ${c.fundingLinkFound ? `YES (hop ${c.fundingLinkHopDistance}${c.fundingLinkDetail ? ", " + c.fundingLinkDetail : ""})` : "no"}`,
    );
  }

  if (!c.sellTimingChecked) {
    lines.push(`  sell timing: UNKNOWN (check failed -- see data gaps)`);
  } else if (c.sellTiming.length === 0) {
    lines.push(`  sell timing: no comparable data`);
  } else {
    lines.push(`  sell timing (per token, candidate vs. main wallet hold time):`);
    for (const s of c.sellTiming) {
      const verdict = s.candidateSoldSooner == null ? "n/a" : s.candidateSoldSooner ? "sold sooner" : "held longer/same";
      lines.push(`    - ${s.tokenSymbol}: candidate ${pct(s.candidateHoldMinutes)} vs. main wallet ${pct(s.mainWalletHoldMinutes)} (${verdict})`);
    }
  }

  lines.push(`  fee-payer overlap: ${!c.feePayerChecked ? "UNKNOWN (check failed)" : c.feePayerOverlapFound ? `YES (${c.feePayerOverlapDetail})` : "no"}`);

  if (c.dataGapsNote) lines.push(`  DATA GAPS: ${c.dataGapsNote}`);
  if (c.suggestedForExclusion) {
    lines.push(`  >>> SUGGESTED for exclusion-list review (clears overlap + funding-link bar) -- requires manual approval, not auto-applied`);
  }

  return lines.join("\n");
}

export function formatWalletClusterReport(result: WalletClusterRunResult): string {
  const lines: string[] = [];
  lines.push("=".repeat(78));
  lines.push(`WALLET CLUSTER ANALYSIS -- ${result.mainWallet}`);
  lines.push(`run at: ${result.runAt}`);
  lines.push(`params: preBuyWindowMinutes=${result.preBuyWindowMinutes}, minOverlapCount=${result.minOverlapCount}`);
  lines.push("=".repeat(78));
  lines.push("");
  lines.push("This is CORRELATION-BASED INFERENCE, not proof of identity or ownership.");
  lines.push('Every score below means "consistent with being a controlled wallet," never "confirmed."');
  lines.push("");
  lines.push(`Sample: ${result.tokensAnalyzed.length} token(s) analyzed: ${result.tokensAnalyzed.map((t) => t.tokenSymbol).join(", ") || "(none)"}`);

  if (result.sampleTooThin) {
    lines.push("");
    lines.push(`*** SAMPLE TOO THIN TO BE MEANINGFUL ***`);
    lines.push(result.sampleNote ?? "");
    lines.push("Results below (if any) should be read as exploratory, not a reliable finding.");
  }

  lines.push("");
  if (result.candidates.length === 0) {
    lines.push(result.sampleTooThin ? "No candidates surfaced -- and given the sample issue above, that absence isn't a strong finding either." : "No candidate wallets met minOverlapCount.");
  } else {
    lines.push(`${result.candidates.length} candidate wallet(s), ranked by confidence score (overlap count is the dominant factor):`);
    lines.push("");
    result.candidates.forEach((c, i) => {
      lines.push(candidateBlock(c, i));
      lines.push("");
    });
  }

  return lines.join("\n");
}
