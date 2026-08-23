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

export interface TailTradeRowWithLive extends TailTradeRow {
  currentPriceUsd?: number;
  currentMarketCapUsd?: number;
}

/**
 * Adds live data on every /trades read: (1) self-heals rows recorded before
 * symbol resolution existed, re-resolving and persisting a real ticker for
 * any trade still showing the shortened-address placeholder, and (2) for
 * still-OPEN positions, attaches a live current price/market cap so "what I
 * got in at vs. what it is now" doesn't require a separate lookup. Both need
 * a getTokenOverview call for the same token in the open+unresolved case, so
 * they're combined into one call per token rather than two. A failed lookup
 * just leaves the row as-is (placeholder symbol, no current-price fields) --
 * retried on the next fetch, never blocks the response.
 */
async function enrichTradesWithLiveData(trades: TailTradeRow[]): Promise<TailTradeRowWithLive[]> {
  const needsLookup = trades.filter((t) => t.status === "open" || UNRESOLVED_SYMBOL_PATTERN.test(t.token_symbol));

  const enriched: TailTradeRowWithLive[] = trades;
  await Promise.all(
    needsLookup.map(async (t) => {
      try {
        const overview = await getTokenOverview(t.token_address);
        if (UNRESOLVED_SYMBOL_PATTERN.test(t.token_symbol) && overview.symbol) {
          updateTailTradeSymbol(t.id, overview.symbol);
          t.token_symbol = overview.symbol;
        }
        if (t.status === "open") {
          (t as TailTradeRowWithLive).currentPriceUsd = overview.price;
          (t as TailTradeRowWithLive).currentMarketCapUsd = overview.marketCapUsd;
        }
      } catch {
        // leave the row as-is -- retried on the next /trades fetch
      }
    }),
  );
  return enriched;
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
    res.json(await enrichTradesWithLiveData(trades));
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
