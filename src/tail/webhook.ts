import express, { type Router } from "express";
import type { HeliusTransaction } from "../data/helius.js";
import type { TailConfig } from "./config.js";
import { parseSwapForWallet } from "./parseSwap.js";
import { handleParsedBuy, handleParsedSell } from "./mirror.js";
import { insertTailWebhookLog, insertTailCoverageGap, getLastTailWebhookReceivedAt, getActiveTailWalletAddresses } from "./db.js";

/**
 * Push-based Helius webhook receiver -- NOT a poller. Register this route's
 * public URL (https://<your-deploy>/api/tail/webhook) as an "Enhanced" /
 * SWAP-type webhook in the Helius dashboard, watching the wallet(s) tailed.
 * The watch list is DB-driven (tail_wallets, managed via the dashboard's
 * add/remove wallet actions -- see dashboardRoutes.ts), re-read fresh on
 * every incoming delivery rather than fixed at startup, so a wallet added
 * through the dashboard is tailed immediately without a restart. See
 * README's wallet-tail section for the Helius-side setup.
 *
 * Responds 200 as fast as possible, BEFORE running any of the simulated
 * pipeline delay or price lookups (see mirror.ts) -- holding the connection
 * open for the full delay would risk the provider treating a slow response
 * as a failed delivery and retrying, double-counting the trade.
 */
export function createTailWebhookRouter(config: TailConfig): Router {
  const router = express.Router();

  // Relies on the parent app's express.json() (mounted globally in
  // dashboard/server.ts) rather than its own -- body-parser skips re-parsing
  // once req._body is set, so a second json() here would be redundant.
  router.post("/webhook", (req, res) => {
    if (config.webhookSecret) {
      const provided = req.headers["authorization"];
      if (provided !== config.webhookSecret) {
        insertTailWebhookLog(null, null, "auth_rejected", `unauthorized webhook POST (authorization header did not match TAIL_WEBHOOK_SECRET)`);
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    }

    res.status(200).json({ received: true });

    const detectedAt = new Date();
    const body = req.body;
    const txs: HeliusTransaction[] = Array.isArray(body) ? body : body ? [body] : [];

    const activeWallets = getActiveTailWalletAddresses();
    for (const tx of txs) {
      for (const walletAddress of activeWallets) {
        if (!isWalletInvolved(tx, walletAddress)) continue;

        void (async () => {
          try {
            const parsed = parseSwapForWallet(tx, walletAddress);
            if (!parsed.ok) {
              insertTailWebhookLog(walletAddress, tx?.signature ?? null, "ignored_non_swap", parsed.reason);
              return;
            }
            if (parsed.swap.side === "buy") {
              await handleParsedBuy(parsed.swap, walletAddress, detectedAt, config);
            } else {
              await handleParsedSell(parsed.swap, walletAddress, detectedAt, config);
            }
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            insertTailCoverageGap(walletAddress, null, "handler_error", `webhook handler threw while processing tx ${tx?.signature}: ${detail}`);
          }
        })();
      }
    }
  });

  return router;
}

function isWalletInvolved(tx: HeliusTransaction, walletAddress: string): boolean {
  if (tx?.feePayer === walletAddress) return true;
  if ((tx?.tokenTransfers ?? []).some((t) => t.fromUserAccount === walletAddress || t.toUserAccount === walletAddress)) return true;
  if ((tx?.nativeTransfers ?? []).some((t) => t.fromUserAccount === walletAddress || t.toUserAccount === walletAddress)) return true;
  return false;
}

// Threshold past which a gap since the last received webhook event, found at
// startup, gets logged as a possible coverage interruption. Deliberately
// generous -- the tailed wallet going quiet for a while is normal and not
// itself a problem; this is only meant to flag "the server was down or
// misconfigured for a suspiciously long stretch," not every quiet period.
const STARTUP_GAP_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Best-effort, self-side-only gap detection: compares now against the last
 * webhook event this server actually recorded. This can only see gaps
 * caused by THIS server being down/erroring -- it has no visibility into
 * whether Helius attempted delivery during that window and failed, since a
 * delivery that never reached this server leaves no record here at all.
 */
export function logStartupCoverageGapIfAny(walletAddresses: string[]): void {
  const lastReceivedAt = getLastTailWebhookReceivedAt();
  if (!lastReceivedAt) return; // never received anything yet -- nothing to compare against

  const gapMs = Date.now() - new Date(lastReceivedAt).getTime();
  if (gapMs < STARTUP_GAP_THRESHOLD_MS) return;

  const gapHours = (gapMs / (60 * 60 * 1000)).toFixed(1);
  for (const walletAddress of walletAddresses) {
    insertTailCoverageGap(
      walletAddress,
      lastReceivedAt,
      "startup_gap",
      `no webhook event recorded for ~${gapHours}h before this startup -- may reflect the server being down, or simply the wallet being inactive; cannot distinguish the two from here`,
    );
  }
}
