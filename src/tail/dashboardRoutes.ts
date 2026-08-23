import express, { type Router } from "express";
import type { TailConfig } from "./config.js";
import { getAllTailTrades, getRecentTailWebhookLog, getRecentTailCoverageGaps, updateTailTradeSymbol, type TailTradeRow } from "./db.js";
import { computeTailSummary } from "./summary.js";
import { getTokenOverview } from "../data/priceProvider.js";

// Matches tokenSymbolFor's shortened-address fallback in mirror.ts (e.g.
// "FsLJ…pump") -- a real ticker essentially never has this exact shape, so
// it's a safe signal that a row predates the symbol-resolving fix and is
// worth trying to re-resolve now that a real lookup exists.
const UNRESOLVED_SYMBOL_PATTERN = /^.{4}….{4}$/;

/**
 * Self-heals rows recorded before symbol resolution existed: re-resolves and
 * persists a real ticker for any trade still showing the shortened-address
 * placeholder. Runs on every /trades read, but only does work for rows that
 * still need it -- once resolved, a row is never touched again. A failed
 * lookup just leaves the placeholder in place to retry next read, same
 * fail-open behavior as the original resolution attempt.
 */
async function backfillUnresolvedSymbols(trades: TailTradeRow[]): Promise<void> {
  const unresolved = trades.filter((t) => UNRESOLVED_SYMBOL_PATTERN.test(t.token_symbol));
  if (unresolved.length === 0) return;

  await Promise.all(
    unresolved.map(async (t) => {
      try {
        const overview = await getTokenOverview(t.token_address);
        if (overview.symbol) {
          updateTailTradeSymbol(t.id, overview.symbol);
          t.token_symbol = overview.symbol;
        }
      } catch {
        // leave the placeholder -- retried on the next /trades fetch
      }
    }),
  );
}

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

  router.get("/trades", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const trades = getAllTailTrades(undefined, limit);
    await backfillUnresolvedSymbols(trades);
    res.json(trades);
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
