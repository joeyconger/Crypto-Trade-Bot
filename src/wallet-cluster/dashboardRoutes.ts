import express, { type Router } from "express";
import {
  getWalletClusterRuns,
  getWalletClusterRunById,
  getWalletClusterCandidates,
  getPendingExclusionSuggestions,
  reviewCandidate,
} from "./db.js";

/**
 * Read-only status/data routes for the wallet-clustering research module,
 * plus the one write action this module has: a human approving/rejecting a
 * suggested exclusion-list candidate (never automatic -- see pipeline.ts
 * and schema.sql). Entirely separate from the main strategy's and the
 * wallet-tail module's routes/tables.
 */
export function createWalletClusterDashboardRouter(): Router {
  const router = express.Router();

  router.get("/runs", (req, res) => {
    const mainWallet = typeof req.query.mainWallet === "string" ? req.query.mainWallet : undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json(getWalletClusterRuns(mainWallet, limit));
  });

  router.get("/runs/:runId/candidates", (req, res) => {
    const runId = Number(req.params.runId);
    const run = getWalletClusterRunById(runId);
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    res.json({ run, candidates: getWalletClusterCandidates(runId) });
  });

  router.get("/exclusion-suggestions", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(getPendingExclusionSuggestions(limit));
  });

  // The only write path in this module -- a human reviewing one suggested
  // candidate. Never auto-applies anywhere; approving here just records the
  // review decision.
  router.post("/candidates/:candidateId/review", express.json(), (req, res) => {
    const candidateId = Number(req.params.candidateId);
    const status = req.body?.status;
    if (status !== "approved" && status !== "rejected") {
      res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
      return;
    }
    reviewCandidate(candidateId, status, typeof req.body?.note === "string" ? req.body.note : null);
    res.json({ ok: true });
  });

  return router;
}
