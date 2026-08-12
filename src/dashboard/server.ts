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
  getRealizedPnlSince,
  getPositionExits,
  getTradeSignalWallets,
  getCircuitBreakerState,
  getWatchlistTokensFromDb,
  getWatchlistLastRefreshedAt,
  getWatchlistRefreshError,
} from "../db/index.js";
import { checkCircuitBreakers, resumeWeeklyHalt, resumeConsecutiveLossHalt } from "../execution/circuitBreakers.js";
import { getTokenOverview } from "../data/priceProvider.js";
import { getBotWalletBalanceUsd } from "../execution/liveTrading.js";
import type { RiskConfig } from "../types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function todayStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function sevenDaysAgoIso(): string {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

async function resolveMode(): Promise<{ mode: "paper" | "live"; bankrollUsd: number }> {
  const mode = env.liveTradingEnabled ? "live" : "paper";
  if (mode === "paper") return { mode, bankrollUsd: env.PAPER_STARTING_BALANCE_USD };

  try {
    return { mode, bankrollUsd: await getBotWalletBalanceUsd() };
  } catch (err) {
    console.error("Failed to fetch live bankroll for dashboard:", err instanceof Error ? err.message : err);
    return { mode, bankrollUsd: 0 };
  }
}

/**
 * A single, unambiguous run state -- paused (manual) / halted (a circuit
 * breaker tripped) / running -- never two truths at once. Paused always wins
 * (the manual override); halted covers daily/weekly/consecutive-loss limits,
 * any of which still let existing positions keep being managed for exit,
 * they just block new entries.
 */
function computeRunState(mode: "paper" | "live", risk: RiskConfig, bankrollUsd: number) {
  if (getBotState().paused) return { state: "paused" as const };

  const check = checkCircuitBreakers(mode, risk, bankrollUsd);
  if (!check.allowed) return { state: "halted" as const, reason: check.reason };

  return { state: "running" as const };
}

export function createDashboardServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/status", async (_req, res) => {
    const config = loadWatchlistConfig();
    const { mode, bankrollUsd } = await resolveMode();

    // In top_traded mode the real watchlist is whatever the poll loop last
    // resolved into the DB (up to topTradedCount dynamic picks + pins), not
    // the static config.tokens list -- that's just the pins.
    const watchlist =
      config.watchlistSource.mode === "top_traded"
        ? (() => {
            const count = getWatchlistTokensFromDb().length;
            return {
              enabled: count,
              total: count,
              lastRefreshedAt: getWatchlistLastRefreshedAt() ?? null,
              // Set only when the most recent refresh attempt failed --
              // still-populated + non-null here means the dynamic list is
              // stuck on its last-known-good state (or pins-only) and why.
              lastRefreshError: getWatchlistRefreshError() ?? null,
            };
          })()
        : { enabled: config.tokens.filter((t) => t.enabled).length, total: config.tokens.length };

    const runState = computeRunState(mode, config.risk, bankrollUsd);
    const cbState = getCircuitBreakerState();
    const realizedPnlAllTimeUsd = getRealizedPnlAllTime();
    const dailyPnl = getRealizedPnlSince(mode, todayStartIso());
    const weeklyPnl = getRealizedPnlSince(mode, sevenDaysAgoIso());

    res.json({
      mode,
      runState,
      pollIntervalSeconds: env.POLL_INTERVAL_SECONDS,
      watchlist,
      openPositionsCount: getOpenTrades().filter((t) => t.mode === mode).length,
      risk: {
        riskPctPerTrade: config.risk.riskPctPerTrade,
        riskPctPerTradeTierB: config.risk.riskPctPerTradeTierB,
        maxPositionSizePct: config.risk.maxPositionSizePct,
        maxConcurrentPositions: config.risk.maxConcurrentPositions,
        dailyPnlUsd: dailyPnl,
        dailyLimitUsd: bankrollUsd * (config.risk.dailyLossLimitPct / 100),
        weeklyPnlUsd: weeklyPnl,
        weeklyLimitUsd: bankrollUsd * (config.risk.weeklyLossLimitPct / 100),
        weeklyHalted: !!cbState.weekly_halted,
        consecutiveLosses: cbState.consecutive_losses,
        consecutiveLossLimit: config.risk.consecutiveLossLimit,
        consecutiveLossHalted: !!cbState.consecutive_loss_halted,
      },
      equity: {
        bankrollUsd,
        realizedPnlAllTimeUsd,
        currentBalanceUsd: mode === "live" ? bankrollUsd : bankrollUsd + realizedPnlAllTimeUsd,
      },
    });
  });

  app.get("/api/positions", async (_req, res) => {
    const trades = getOpenTrades();

    const positions = await Promise.all(
      trades.map(async (trade) => {
        const exits = getPositionExits(trade.id);
        const wallets = getTradeSignalWallets(trade.id);

        try {
          const overview = await getTokenOverview(trade.token_address);
          const unrealizedPnlUsd = (overview.price - trade.entry_price) * trade.quantity_remaining;
          return {
            ...trade,
            currentPrice: overview.price,
            unrealizedPnlUsd,
            unrealizedPnlPct: (unrealizedPnlUsd / trade.usd_size) * 100,
            exits,
            wallets,
          };
        } catch {
          return { ...trade, currentPrice: null, unrealizedPnlUsd: null, unrealizedPnlPct: null, exits, wallets };
        }
      }),
    );

    res.json(positions);
  });

  app.get("/api/trades", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const trades = getClosedTrades(limit);
    res.json(trades.map((trade) => ({ ...trade, exits: getPositionExits(trade.id), wallets: getTradeSignalWallets(trade.id) })));
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

  app.post("/api/resume-weekly-halt", (_req, res) => {
    resumeWeeklyHalt();
    res.json({ weeklyHalted: false });
  });

  app.post("/api/resume-consecutive-loss-halt", (_req, res) => {
    resumeConsecutiveLossHalt();
    res.json({ consecutiveLossHalted: false });
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
