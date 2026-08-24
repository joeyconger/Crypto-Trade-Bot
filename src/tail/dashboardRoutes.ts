import express, { type Router } from "express";
import type { TailConfig } from "./config.js";
import {
  getAllTailTrades,
  getRecentTailWebhookLog,
  getRecentTailCoverageGaps,
  updateTailTradeSymbol,
  getTailWallets,
  upsertTailWallet,
  setTailWalletEnabled,
  getTailTradeById,
  closeTailTradeManually,
  type TailTradeRow,
  type TailWebhookLogStatus,
} from "./db.js";
import { computeTailSummary } from "./summary.js";
import { getTokenOverview } from "../data/priceProvider.js";
import { addAddressToWebhook, removeAddressFromWebhook } from "../data/heliusWebhook.js";
import { executeLiveSell } from "./liveExecution.js";

// Solana addresses are base58 (no 0/O/I/l), typically 32-44 chars. Not a
// full validity check (doesn't confirm the account exists or is even a
// wallet) -- just enough to reject an obvious typo/garbage input before it
// gets persisted and sent to Helius.
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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
    const wallets = getTailWallets();
    res.json({
      enabled: config.enabled,
      wallets: wallets.map((w) => ({ address: w.address, label: w.label, enabled: !!w.enabled })),
      // Kept for existing callers -- includes disabled wallets too (a
      // removed wallet's past trades still need a label to display).
      walletLabels: Object.fromEntries(wallets.filter((w) => w.label).map((w) => [w.address, w.label as string])),
      positionSizePct: config.positionSizePct,
      simulatedDelaySeconds: config.simulatedDelaySeconds,
      startingBalanceUsd: config.startingBalanceUsd,
      // Whether adding/removing a wallet in the dashboard will also update
      // the Helius webhook automatically, or just this app's own DB.
      heliusSyncConfigured: !!config.heliusWebhookId,
      // REAL funds, REAL swaps, the instant a tailed wallet trades -- see
      // README's "Going live" subsection. The dashboard should make this
      // loud, not a subtle badge.
      liveTradingEnabled: config.liveTradingEnabled,
      liveSlippageBps: config.liveSlippageBps,
      liveDailyLossLimitPct: config.liveDailyLossLimitPct,
      liveDailyLossCapEnabled: config.liveDailyLossCapEnabled,
    });
  });

  /**
   * Adds (or re-enables) a tailed wallet, and -- if TAIL_HELIUS_WEBHOOK_ID is
   * set -- adds it to the Helius webhook's watched-address list too, so
   * tailing actually starts without a manual step in Helius's dashboard.
   * The DB write always happens; the Helius call is best-effort and its
   * outcome is reported back rather than failing the whole request, since a
   * wallet added here but not yet in Helius is still a useful, correctable
   * state (not silently broken).
   */
  router.post("/wallets", async (req, res) => {
    const address = String(req.body?.address ?? "").trim();
    const label = req.body?.label ? String(req.body.label).trim() : null;

    if (!SOLANA_ADDRESS_PATTERN.test(address)) {
      res.status(400).json({ error: "not a valid-looking Solana address" });
      return;
    }

    upsertTailWallet(address, label);

    if (!config.heliusWebhookId) {
      res.json({ ok: true, heliusSynced: false, heliusSkippedReason: "TAIL_HELIUS_WEBHOOK_ID not set -- add this address to your Helius webhook manually" });
      return;
    }
    try {
      await addAddressToWebhook(config.heliusWebhookId, address);
      res.json({ ok: true, heliusSynced: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      res.json({ ok: true, heliusSynced: false, heliusError: detail });
    }
  });

  /**
   * Soft-removes a tailed wallet (kept in the DB, disabled -- its trade
   * history stays visible) and, if configured, removes it from the Helius
   * webhook too. Any position still `open` for this wallet will never see
   * its matching sell once Helius stops forwarding this wallet's
   * transactions, so the response includes how many would be stranded --
   * the dashboard should surface that before the user confirms.
   */
  router.delete("/wallets/:address", async (req, res) => {
    const address = req.params.address;
    const strandedOpenCount = getAllTailTrades(address, 5000).filter((t) => t.status === "open").length;

    setTailWalletEnabled(address, false);

    if (!config.heliusWebhookId) {
      res.json({ ok: true, strandedOpenCount, heliusSynced: false, heliusSkippedReason: "TAIL_HELIUS_WEBHOOK_ID not set -- remove this address from your Helius webhook manually" });
      return;
    }
    try {
      await removeAddressFromWebhook(config.heliusWebhookId, address);
      res.json({ ok: true, strandedOpenCount, heliusSynced: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      res.json({ ok: true, strandedOpenCount, heliusSynced: false, heliusError: detail });
    }
  });

  router.get("/trades", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const trades = getAllTailTrades(undefined, limit);
    res.json(await enrichTradesWithLiveData(trades));
  });

  /**
   * Manually closes an open tail_trade -- a substitute exit signal for
   * cases with no reliable automated one (e.g. this app has no pump.fun
   * "callout" scraper), so a position doesn't just sit open forever waiting
   * for a wallet sell that may not be detectable. For a live position
   * (trade.is_live) this is a REAL swap of the actual held quantity
   * (read fresh from the chain, not the DB's recorded quantity, in case of
   * drift); for a paper position it's a fresh price lookup, same as always.
   * Marked closed_manually so it's distinguishable from a wallet-mirrored
   * exit everywhere the dashboard/summary reads trades.
   */
  router.post("/trades/:id/sell", async (req, res) => {
    const tradeId = Number(req.params.id);
    const trade = getTailTradeById(tradeId);
    if (!trade) {
      res.status(404).json({ error: "trade not found" });
      return;
    }
    if (trade.status !== "open") {
      res.status(400).json({ error: `trade is already ${trade.status.replace("_", " ")}, nothing to sell` });
      return;
    }

    if (trade.is_live) {
      const result = await executeLiveSell(trade.token_address);
      if (!result.ok) {
        res.status(502).json({ error: result.reason });
        return;
      }
      // Guarded on status='open' (see closeTailTradeManually's docstring) --
      // a tailed-wallet sell can race this same click and win, in which case
      // the swap above still genuinely succeeded (real SOL was received)
      // but this row is no longer the one to record it on.
      const { applied } = closeTailTradeManually({
        tradeId,
        exitPriceUsd: result.fillPriceUsd,
        exitLiquidityUsd: null,
        exitMarketCapUsd: null,
        ownExitTxSignature: result.signature,
      });
      if (!applied) {
        res.status(409).json({
          error: `sell executed (tx ${result.signature}) but the position was already closed by a wallet-mirrored exit that landed first -- check the trade's history, no need to sell again`,
        });
        return;
      }
      res.json({ ok: true, exitPriceUsd: result.fillPriceUsd, signature: result.signature });
      return;
    }

    try {
      const overview = await getTokenOverview(trade.token_address);
      if (!overview || !Number.isFinite(overview.price) || overview.price <= 0) {
        res.status(502).json({ error: "no usable current price available right now -- try again in a moment" });
        return;
      }
      const { applied } = closeTailTradeManually({
        tradeId,
        exitPriceUsd: overview.price,
        exitLiquidityUsd: overview.liquidityUsd ?? null,
        exitMarketCapUsd: overview.marketCapUsd ?? null,
      });
      if (!applied) {
        res.status(409).json({ error: "position was already closed by a wallet-mirrored exit -- no need to sell again" });
        return;
      }
      res.json({ ok: true, exitPriceUsd: overview.price });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/summary", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 1000, 5000);
    const allTrades = getAllTailTrades(undefined, limit);

    // Per-wallet breakdown -- the whole point once more than one wallet is
    // tailed at once, otherwise a losing wallet's trades silently drag down
    // (or a winning wallet's silently flatter) the combined "overall"
    // number with no way to tell them apart. Includes disabled (removed)
    // wallets too, since their trade history shouldn't just disappear --
    // the dashboard can gray those out using the `enabled` flag.
    const byWallet = getTailWallets().map((w) => ({
      walletAddress: w.address,
      label: w.label,
      enabled: !!w.enabled,
      summary: computeTailSummary(allTrades.filter((t) => t.wallet_address === w.address)),
    }));

    res.json({
      overall: computeTailSummary(allTrades),
      byWallet,
    });
  });

  router.get("/webhook-log", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const status = req.query.status ? (String(req.query.status) as TailWebhookLogStatus) : undefined;
    res.json(getRecentTailWebhookLog(limit, status));
  });

  router.get("/coverage-gaps", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json(getRecentTailCoverageGaps(limit));
  });

  return router;
}
