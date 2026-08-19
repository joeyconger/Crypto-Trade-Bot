import express, { type Router } from "express";
import type { TailConfig } from "./config.js";
import { getAllTailTrades, getRecentTailWebhookLog, getRecentTailCoverageGaps } from "./db.js";
import { computeTailSummary } from "./summary.js";

/**
 * Read-only status/data routes for the dashboard's wallet-tail section.
 * Entirely separate from the main strategy's /api/status, /api/positions,
 * /api/trades -- see src/dashboard/server.ts, which mounts this under
 * /api/tail and never mixes its data into the main equity/P&L payload.
 */
export function createTailDashboardRouter(config: TailConfig): Router {
  const router = express.Router();

  router.get("/status", (_req, res) => {
    res.json({
      enabled: config.enabled,
      walletAddresses: config.walletAddresses,
      positionSizePct: config.positionSizePct,
      simulatedDelaySeconds: config.simulatedDelaySeconds,
      startingBalanceUsd: config.startingBalanceUsd,
    });
  });

  router.get("/trades", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    res.json(getAllTailTrades(undefined, limit));
  });

  router.get("/summary", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 1000, 5000);
    res.json(computeTailSummary(getAllTailTrades(undefined, limit)));
  });

  router.get("/webhook-log", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(getRecentTailWebhookLog(limit));
  });

  router.get("/coverage-gaps", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json(getRecentTailCoverageGaps(limit));
  });

  return router;
}
