import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db/index.js";
import type { WalletClusterRunResult, CandidateResult } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let initialized = false;

/** Applies wallet_cluster_*'s own schema against the shared DB connection. Idempotent, safe to call on every startup/run. */
export function initWalletClusterSchema(): void {
  if (initialized) return;
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  getDb().exec(schema);
  initialized = true;
}

export interface WalletClusterRunRow {
  id: number;
  main_wallet: string;
  run_at: string;
  pre_buy_window_minutes: number;
  min_overlap_count: number;
  tokens_analyzed_json: string;
  token_count: number;
  sample_too_thin: number;
  sample_note: string | null;
  candidates_found: number;
}

/** Persists a completed run and its candidates. Returns the run id. */
export function saveWalletClusterRun(result: WalletClusterRunResult): number {
  const db = getDb();

  const insertRun = db.prepare(
    `INSERT INTO wallet_cluster_runs (
      main_wallet, run_at, pre_buy_window_minutes, min_overlap_count,
      tokens_analyzed_json, token_count, sample_too_thin, sample_note, candidates_found
    ) VALUES (
      @mainWallet, @runAt, @preBuyWindowMinutes, @minOverlapCount,
      @tokensAnalyzedJson, @tokenCount, @sampleTooThin, @sampleNote, @candidatesFound
    )`,
  );

  const insertCandidate = db.prepare(
    `INSERT INTO wallet_cluster_candidates (
      run_id, candidate_wallet, overlap_count, overlap_tokens_json,
      funding_link_found, funding_link_hop_distance, funding_link_detail,
      sell_timing_json, fee_payer_overlap_found, fee_payer_overlap_detail,
      funding_link_checked, sell_timing_checked, fee_payer_checked, data_gaps_note,
      confidence_score, confidence_band, suggested_for_exclusion
    ) VALUES (
      @runId, @candidateWallet, @overlapCount, @overlapTokensJson,
      @fundingLinkFound, @fundingLinkHopDistance, @fundingLinkDetail,
      @sellTimingJson, @feePayerOverlapFound, @feePayerOverlapDetail,
      @fundingLinkChecked, @sellTimingChecked, @feePayerChecked, @dataGapsNote,
      @confidenceScore, @confidenceBand, @suggestedForExclusion
    )`,
  );

  const tx = db.transaction((r: WalletClusterRunResult) => {
    const runResult = insertRun.run({
      mainWallet: r.mainWallet,
      runAt: r.runAt,
      preBuyWindowMinutes: r.preBuyWindowMinutes,
      minOverlapCount: r.minOverlapCount,
      tokensAnalyzedJson: JSON.stringify(r.tokensAnalyzed),
      tokenCount: r.tokensAnalyzed.length,
      sampleTooThin: r.sampleTooThin ? 1 : 0,
      sampleNote: r.sampleNote ?? null,
      candidatesFound: r.candidates.length,
    });
    const runId = Number(runResult.lastInsertRowid);

    for (const c of r.candidates) {
      insertCandidate.run({
        runId,
        candidateWallet: c.candidateWallet,
        overlapCount: c.overlapCount,
        overlapTokensJson: JSON.stringify(c.overlapTokens),
        fundingLinkFound: c.fundingLinkFound ? 1 : 0,
        fundingLinkHopDistance: c.fundingLinkHopDistance,
        fundingLinkDetail: c.fundingLinkDetail ?? null,
        sellTimingJson: JSON.stringify(c.sellTiming),
        feePayerOverlapFound: c.feePayerOverlapFound ? 1 : 0,
        feePayerOverlapDetail: c.feePayerOverlapDetail ?? null,
        fundingLinkChecked: c.fundingLinkChecked ? 1 : 0,
        sellTimingChecked: c.sellTimingChecked ? 1 : 0,
        feePayerChecked: c.feePayerChecked ? 1 : 0,
        dataGapsNote: c.dataGapsNote ?? null,
        confidenceScore: c.confidenceScore,
        confidenceBand: c.confidenceBand,
        suggestedForExclusion: c.suggestedForExclusion ? 1 : 0,
      });
    }

    return runId;
  });

  return tx(result);
}

export function getWalletClusterRuns(mainWallet?: string, limit = 50): WalletClusterRunRow[] {
  if (mainWallet) {
    return getDb()
      .prepare(`SELECT * FROM wallet_cluster_runs WHERE main_wallet = ? ORDER BY run_at DESC LIMIT ?`)
      .all(mainWallet, limit) as WalletClusterRunRow[];
  }
  return getDb().prepare(`SELECT * FROM wallet_cluster_runs ORDER BY run_at DESC LIMIT ?`).all(limit) as WalletClusterRunRow[];
}

export function getWalletClusterRunById(runId: number): WalletClusterRunRow | undefined {
  return getDb().prepare(`SELECT * FROM wallet_cluster_runs WHERE id = ?`).get(runId) as WalletClusterRunRow | undefined;
}

export interface WalletClusterCandidateRow {
  id: number;
  run_id: number;
  candidate_wallet: string;
  overlap_count: number;
  overlap_tokens_json: string;
  funding_link_found: number;
  funding_link_hop_distance: number | null;
  funding_link_detail: string | null;
  sell_timing_json: string | null;
  fee_payer_overlap_found: number;
  fee_payer_overlap_detail: string | null;
  funding_link_checked: number;
  sell_timing_checked: number;
  fee_payer_checked: number;
  data_gaps_note: string | null;
  confidence_score: number;
  confidence_band: string;
  suggested_for_exclusion: number;
  review_status: "pending" | "approved" | "rejected";
  reviewed_at: string | null;
  reviewed_note: string | null;
  created_at: string;
}

export function getWalletClusterCandidates(runId: number): WalletClusterCandidateRow[] {
  return getDb()
    .prepare(`SELECT * FROM wallet_cluster_candidates WHERE run_id = ? ORDER BY confidence_score DESC`)
    .all(runId) as WalletClusterCandidateRow[];
}

export function getPendingExclusionSuggestions(limit = 100): WalletClusterCandidateRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM wallet_cluster_candidates WHERE suggested_for_exclusion = 1 AND review_status = 'pending' ORDER BY confidence_score DESC LIMIT ?`,
    )
    .all(limit) as WalletClusterCandidateRow[];
}

/** Manual review action -- a human approves or rejects a suggested exclusion-list candidate. Never called automatically. */
export function reviewCandidate(candidateId: number, status: "approved" | "rejected", note: string | null): void {
  getDb()
    .prepare(
      `UPDATE wallet_cluster_candidates SET review_status = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), reviewed_note = ? WHERE id = ?`,
    )
    .run(status, note, candidateId);
}
