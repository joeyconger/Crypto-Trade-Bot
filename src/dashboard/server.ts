import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { getBotWalletBalanceUsd } from "../execution/liveTrading.js";
import { getBotPublicKeyString } from "../solana/keypair.js";
import { loadTailConfig } from "../tail/config.js";
import { createTailWebhookRouter } from "../tail/webhook.js";
import { createTailDashboardRouter } from "../tail/dashboardRoutes.js";
import { initWalletClusterSchema } from "../wallet-cluster/db.js";
import { createWalletClusterDashboardRouter } from "../wallet-cluster/dashboardRoutes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createDashboardServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  // Wallet-tail -- mirrors specific wallets' swaps, paper by default, real
  // execution when TAIL_LIVE_TRADING is on (see src/tail/liveExecution.ts).
  // Its routes are namespaced under /api/tail.
  const tailConfig = loadTailConfig();
  if (tailConfig.enabled) {
    app.use("/api/tail", createTailWebhookRouter(tailConfig));
    app.use("/api/tail", createTailDashboardRouter(tailConfig));
  }

  // Wallet-clustering / side-wallet detection -- a standalone, manually-run
  // analysis tool (see src/wallet-cluster/). Read-only against its own
  // tables except one write path (a human approving/rejecting a suggested
  // exclusion-list candidate) -- no execution, no config changes.
  initWalletClusterSchema();
  app.use("/api/wallet-cluster", createWalletClusterDashboardRouter());

  // Live wallet balance -- only meaningful once BOT_PRIVATE_KEY is set
  // (paper mode has no on-chain wallet to check). Separate from
  // /api/tail/status so a balance-lookup failure never breaks the rest of
  // that endpoint's response. The public address (safe to show -- it's
  // what you fund/look up on Solscan, unlike the private key) is derived
  // from the keypair with no network call, so it's included even when the
  // balance/price lookup itself fails (e.g. a price-provider outage
  // shouldn't hide the one thing you'd need to go check the wallet
  // directly on-chain).
  app.get("/api/live-balance", async (_req, res) => {
    if (!env.BOT_PRIVATE_KEY) {
      res.json({ available: false, reason: "BOT_PRIVATE_KEY not set" });
      return;
    }
    let address: string | undefined;
    try {
      address = getBotPublicKeyString();
    } catch {
      // Malformed BOT_PRIVATE_KEY -- fall through, the balance fetch below
      // will hit the same error and produce a proper reason string.
    }
    try {
      const balanceUsd = await getBotWalletBalanceUsd();
      res.json({ available: true, balanceUsd, address });
    } catch (err) {
      res.json({ available: false, reason: err instanceof Error ? err.message : String(err), address });
    }
  });

  return app;
}

export function startDashboardServer(): void {
  const app = createDashboardServer();
  const port = Number(process.env.PORT) || env.DASHBOARD_PORT;
  app.listen(port, () => {
    console.log(`Dashboard listening on port ${port}`);
  });
}
