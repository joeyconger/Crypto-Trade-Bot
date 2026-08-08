import { loadWatchlistConfig } from "../config/watchlist.js";
import { syncWatchlistTokens } from "../db/index.js";
import { evaluateToken, logSignalEvaluation } from "./scoring.js";
import { getRiskState, canOpenPosition, computePositionSizeUsd } from "../execution/risk.js";
import { getOpenTrade, openPaperPosition, closePaperPosition } from "../execution/paperTrading.js";
import type { TokenConfig, WatchlistConfig } from "../types/index.js";

async function evaluateAndActOnToken(token: TokenConfig, config: WatchlistConfig): Promise<void> {
  const result = await evaluateToken(token);
  const currentPrice = result.technical.currentPrice;
  const openTrade = getOpenTrade(token.address);

  if (openTrade) {
    let exitReason: string | undefined;
    if (openTrade.stop_loss_price != null && currentPrice <= openTrade.stop_loss_price) {
      exitReason = `stop loss hit (price ${currentPrice} <= ${openTrade.stop_loss_price})`;
    } else if (openTrade.take_profit_price != null && currentPrice >= openTrade.take_profit_price) {
      exitReason = `take profit hit (price ${currentPrice} >= ${openTrade.take_profit_price})`;
    } else if (result.action === "sell") {
      exitReason = `sell signal (combined score ${result.combinedScore.toFixed(2)})`;
    }

    if (exitReason) {
      closePaperPosition(openTrade, currentPrice, exitReason);
      console.log(`[${token.symbol}] closed paper position #${openTrade.id}: ${exitReason}`);
      logSignalEvaluation(result, openTrade.id);
      return;
    }

    logSignalEvaluation(result);
    return;
  }

  if (result.action === "buy") {
    const riskState = getRiskState(config.risk);
    const { allowed, reason: blockReason } = canOpenPosition(config.risk, riskState);

    if (!allowed) {
      console.log(`[${token.symbol}] buy signal blocked: ${blockReason}`);
      logSignalEvaluation({ ...result, action: "none" });
      return;
    }

    const usdSize = computePositionSizeUsd(token, config.risk);
    const openReason =
      `buy signal (combined score ${result.combinedScore.toFixed(2)}): ` +
      `technical=${result.technical.score.toFixed(2)}, onchain=${result.onchain.score.toFixed(2)}, social=${result.social.score.toFixed(2)}`;

    const tradeId = openPaperPosition(token, currentPrice, usdSize, openReason);
    console.log(`[${token.symbol}] opened paper position #${tradeId}: $${usdSize.toFixed(2)} @ ${currentPrice}`);
    logSignalEvaluation(result, tradeId);
    return;
  }

  logSignalEvaluation(result);
}

export async function runPollCycle(): Promise<void> {
  const config = loadWatchlistConfig();
  syncWatchlistTokens(config);

  for (const token of config.tokens.filter((t) => t.enabled)) {
    try {
      await evaluateAndActOnToken(token, config);
    } catch (err) {
      console.error(`[${token.symbol}] evaluation failed:`, err instanceof Error ? err.message : err);
    }
  }
}

export function startPollLoop(intervalSeconds: number): NodeJS.Timeout {
  console.log(`Starting poll loop (every ${intervalSeconds}s)`);
  runPollCycle().catch((err) => console.error("Poll cycle failed:", err));
  return setInterval(() => {
    runPollCycle().catch((err) => console.error("Poll cycle failed:", err));
  }, intervalSeconds * 1000);
}
