import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { loadWatchlistConfig } from "../config/watchlist.js";
import {
  getOpenTrades,
  getClosedTrades,
  getSignalLog,
  getBotState,
  setPaused,
  getRealizedPnlAllTime,
} from "../db/index.js";
import { getRiskState } from "../execution/risk.js";
import { getTokenOverview } from "../data/birdeye.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createDashboardServer() {
  const app = express();
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/status", (_req, res) => {
    const config = loadWatchlistConfig();
    const enabledTokens = config.tokens.filter((t) => t.enabled);
    const riskState = getRiskState(config.risk);
    const botState = getBotState();
    const realizedPnlAllTimeUsd = getRealizedPnlAllTime();

    res.json({
      mode: env.liveTradingEnabled ? "live" : "paper",
      paused: botState.paused,
      pollIntervalSeconds: env.POLL_INTERVAL_SECONDS,
      watchlist: { enabled: enabledTokens.length, total: config.tokens.length },
      risk: {
        openPositionsCount: riskState.openPositionsCount,
        maxConcurrentPositions: config.risk.maxConcurrentPositions,
        realizedPnlTodayUsd: riskState.realizedPnlTodayUsd,
        dailyLossLimitUsd: riskState.dailyLossLimitUsd,
        haltedForDailyLoss: riskState.haltedForDailyLoss,
      },
      equity: {
        startingBalanceUsd: env.PAPER_STARTING_BALANCE_USD,
        realizedPnlAllTimeUsd,
        currentBalanceUsd: env.PAPER_STARTING_BALANCE_USD + realizedPnlAllTimeUsd,
      },
    });
  });

  app.get("/api/positions", async (_req, res) => {
    const trades = getOpenTrades();

    const positions = await Promise.all(
      trades.map(async (trade) => {
        try {
          const overview = await getTokenOverview(trade.token_address);
          const unrealizedPnlUsd = (overview.price - trade.entry_price) * trade.quantity;
          return {
            ...trade,
            currentPrice: overview.price,
            unrealizedPnlUsd,
            unrealizedPnlPct: (unrealizedPnlUsd / trade.usd_size) * 100,
          };
        } catch {
          // Live price unavailable this cycle -- still show the static position fields.
          return { ...trade, currentPrice: null, unrealizedPnlUsd: null, unrealizedPnlPct: null };
        }
      }),
    );

    res.json(positions);
  });

  app.get("/api/trades", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json(getClosedTrades(limit));
  });

  app.get("/api/signals", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(getSignalLog(limit));
  });

  app.post("/api/pause", (_req, res) => {
    setPaused(true);
    res.json({ paused: true });
  });

  app.post("/api/resume", (_req, res) => {
    setPaused(false);
    res.json({ paused: false });
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
