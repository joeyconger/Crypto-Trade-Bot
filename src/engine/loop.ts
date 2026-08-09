import { env } from "../config/env.js";
import { loadWatchlistConfig } from "../config/watchlist.js";
import {
  syncWatchlistTokens,
  getBotState,
  getOpenTrade,
  getTradeById,
  insertSignalLog,
  insertTradeSignalWallet,
  type TradeRow,
} from "../db/index.js";
import { getTokenOverview, getOhlcv, pickOhlcvInterval, type OhlcvCandle } from "../data/birdeye.js";
import { pollWalletActivity } from "../onchain/walletActivity.js";
import { evaluateEntryTrigger } from "../onchain/entryTrigger.js";
import { evaluateTechnicalTrigger } from "../signals/technicalTrigger.js";
import { computeFibExtensions } from "../signals/fib.js";
import { computeATR } from "../signals/atr.js";
import { computePositionSize, computeInitialStop } from "../execution/positionSizing.js";
import { checkCircuitBreakers, recordTradeOutcome } from "../execution/circuitBreakers.js";
import { checkSignalReversal, decideExitAction } from "../execution/exitManager.js";
import { openPaperPosition, executePaperScaleOut, closePaperPositionRemainder } from "../execution/paperTrading.js";
import {
  openLivePosition,
  executeLiveScaleOut,
  closeLivePositionRemainder,
  getBotWalletBalanceUsd,
} from "../execution/liveTrading.js";
import type { PlannedTradeInput } from "../db/index.js";
import type { TokenConfig, WatchlistConfig } from "../types/index.js";

type Mode = "paper" | "live";

async function getBankrollUsd(mode: Mode): Promise<number> {
  return mode === "live" ? getBotWalletBalanceUsd() : env.PAPER_STARTING_BALANCE_USD;
}

async function fetchCandles(token: TokenConfig): Promise<OhlcvCandle[]> {
  const interval = pickOhlcvInterval(token.swingLookbackHours);
  const timeTo = Math.floor(Date.now() / 1000);
  const timeFrom = timeTo - token.swingLookbackHours * 3600;
  return (await getOhlcv(token.address, interval, timeFrom, timeTo)).sort((a, b) => a.unixTime - b.unixTime);
}

async function manageOpenPosition(
  token: TokenConfig,
  config: WatchlistConfig,
  trade: TradeRow,
  currentPrice: number,
  mode: Mode,
): Promise<void> {
  const candles = await fetchCandles(token);
  const hasReversal = checkSignalReversal(trade);
  const action = decideExitAction(trade, currentPrice, candles, token, hasReversal);

  if (action.type === "hold") return;

  if (action.type === "scale_1" || action.type === "scale_2") {
    const exitReason = action.type === "scale_1" ? "extension_1272" : "extension_1618";
    if (mode === "live") {
      await executeLiveScaleOut(trade, action.type, exitReason, token.scaleOutPct1, token.scaleOutPct2);
    } else {
      executePaperScaleOut(trade, action.type, action.exitPrice, exitReason, token.scaleOutPct1, token.scaleOutPct2);
    }
    console.log(`[${token.symbol}] ${action.type} (${exitReason}) at ${action.exitPrice}`);
    return;
  }

  // close_all -- whatever's left, closing now
  if (mode === "live") {
    await closeLivePositionRemainder(trade, action.reason);
  } else {
    closePaperPositionRemainder(trade, action.exitPrice, action.reason);
  }
  console.log(`[${token.symbol}] closed remainder (${action.reason}) at ${action.exitPrice}`);

  const closedTrade = getTradeById(trade.id);
  if (closedTrade?.pnl_usd != null) {
    recordTradeOutcome(closedTrade.pnl_usd, config.risk.consecutiveLossLimit);
  }
}

/**
 * The technical setup (trend + fib/structural confluence + RSI + volume +
 * confirmed close) is the entry gate on its own -- it doesn't need a big
 * wallet to also be buying. On-chain wallet confirmation is evaluated too,
 * but purely as confluence: logged against the trade and folded into its
 * reason when present, never required and never blocking when absent or
 * when the Helius lookup itself fails.
 */
async function considerNewEntry(
  token: TokenConfig,
  config: WatchlistConfig,
  currentPrice: number,
  liquidityUsd: number,
  mode: Mode,
): Promise<void> {
  const candles = await fetchCandles(token);
  const technical = evaluateTechnicalTrigger(candles, currentPrice, token);

  if (!technical.passed) {
    insertSignalLog({
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
      technicalTriggerPassed: false,
      onchainConfluencePresent: false,
      actionTaken: "none",
      detail: JSON.stringify({ skipReason: technical.reason }),
    });
    return;
  }

  const atr = computeATR(candles, token.atrPeriod);
  const swing = technical.swing!;
  const stopPrice = atr !== undefined ? computeInitialStop(swing.lowPrice, atr, token.stopAtrMultiplier) : undefined;

  if (atr === undefined || stopPrice === undefined || stopPrice >= currentPrice) {
    insertSignalLog({
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
      technicalTriggerPassed: true,
      onchainConfluencePresent: false,
      actionTaken: "none",
      detail: JSON.stringify({
        skipReason: atr === undefined ? "not enough candle history for ATR" : "computed stop is not below entry price",
      }),
    });
    return;
  }

  // Optional on-chain confluence -- never blocks the entry, including on error.
  let confirmingWallets: Awaited<ReturnType<typeof evaluateEntryTrigger>>["confirmingWallets"] = [];
  try {
    const onchain = await evaluateEntryTrigger(token, liquidityUsd);
    if (onchain.fired) confirmingWallets = onchain.confirmingWallets;
  } catch (err) {
    console.error(`[${token.symbol}] on-chain confluence check failed (non-blocking):`, err instanceof Error ? err.message : err);
  }
  const hasOnchainConfluence = confirmingWallets.length > 0;

  const bankrollUsd = await getBankrollUsd(mode);
  const circuitCheck = checkCircuitBreakers(mode, config.risk, bankrollUsd);
  if (!circuitCheck.allowed) {
    console.log(`[${token.symbol}] technical trigger fired but blocked: ${circuitCheck.reason}`);
    insertSignalLog({
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
      technicalTriggerPassed: true,
      onchainConfluencePresent: hasOnchainConfluence,
      actionTaken: "none",
      detail: JSON.stringify({ blockedBy: circuitCheck.reason }),
    });
    return;
  }

  const sizing = computePositionSize(bankrollUsd, currentPrice, stopPrice, config.risk.riskPctPerTrade, config.risk.maxPositionSizePct);
  const extensions = computeFibExtensions(swing, [token.extensionRatio1, token.extensionRatio2]);

  const reason = hasOnchainConfluence
    ? `${technical.reason} + on-chain confluence: ${confirmingWallets.length} confirming wallets`
    : technical.reason;

  const plan: PlannedTradeInput = {
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    usdSize: sizing.usdSize,
    swingHigh: swing.highPrice,
    swingLow: swing.lowPrice,
    fibZoneLevel: technical.matchedLevel!.level,
    atrAtEntry: atr,
    extension1272Price: extensions.find((e) => e.level === token.extensionRatio1)!.price,
    extension1618Price: extensions.find((e) => e.level === token.extensionRatio2)!.price,
    stopPrice,
    timeExitDeadline: new Date(Date.now() + token.timeExitHours * 60 * 60 * 1000).toISOString(),
    reason,
  };

  let tradeId: number;
  try {
    tradeId = mode === "live" ? await openLivePosition(plan) : openPaperPosition(plan, currentPrice);
  } catch (err) {
    console.error(`[${token.symbol}] failed to open position:`, err instanceof Error ? err.message : err);
    insertSignalLog({
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
      technicalTriggerPassed: true,
      onchainConfluencePresent: hasOnchainConfluence,
      actionTaken: "none",
      detail: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
    });
    return;
  }

  for (const wallet of confirmingWallets) {
    insertTradeSignalWallet({
      tradeId,
      walletAddress: wallet.walletAddress,
      usdSize: wallet.usdSize,
      reputationScore: wallet.check.reputationScore,
      walletAgeDays: wallet.check.ageDays,
      txSignature: wallet.txSignature,
    });
  }

  console.log(
    `[${token.symbol}] opened ${mode} position #${tradeId}: $${sizing.usdSize.toFixed(2)} @ ${currentPrice} (stop ${stopPrice.toFixed(6)}, onchain confluence=${hasOnchainConfluence}, cap-limited=${sizing.cappedByMaxPosition})`,
  );

  insertSignalLog({
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    technicalTriggerPassed: true,
    onchainConfluencePresent: hasOnchainConfluence,
    actionTaken: "buy",
    detail: JSON.stringify({
      technicalReason: technical.reason,
      confirmingWallets: confirmingWallets.map((w) => w.walletAddress),
      fibZoneLevel: technical.matchedLevel?.level,
      atr,
      stopPrice,
    }),
    tradeId,
  });
}

async function evaluateAndActOnToken(token: TokenConfig, config: WatchlistConfig, mode: Mode): Promise<void> {
  const overview = await getTokenOverview(token.address);

  // Record all observed wallet activity first -- feeds both on-chain
  // confluence and the wallet reputation that improves as the bot runs.
  await pollWalletActivity(token, overview.price);

  const openTrade = getOpenTrade(token.address, mode);

  if (openTrade) {
    await manageOpenPosition(token, config, openTrade, overview.price, mode);
  } else {
    await considerNewEntry(token, config, overview.price, overview.liquidityUsd, mode);
  }
}

// Gap between tokens within a cycle -- each token evaluation makes multiple
// Birdeye calls, and back-to-back tokens with no gap is an easy way to hit
// the free tier's per-second rate limit on the second-plus token every cycle.
const TOKEN_STAGGER_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPollCycle(): Promise<void> {
  if (getBotState().paused) {
    console.log("Bot is paused -- skipping poll cycle");
    return;
  }

  const config = loadWatchlistConfig();
  syncWatchlistTokens(config);
  const mode: Mode = env.liveTradingEnabled ? "live" : "paper";

  const enabledTokens = config.tokens.filter((t) => t.enabled);
  for (let i = 0; i < enabledTokens.length; i++) {
    const token = enabledTokens[i];
    if (i > 0) await sleep(TOKEN_STAGGER_MS);

    try {
      await evaluateAndActOnToken(token, config, mode);
    } catch (err) {
      // A failed evaluation (rate limit, network blip, etc.) still gets a
      // signal_log row -- otherwise the token just silently vanishes from
      // the dashboard for that cycle instead of showing why.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${token.symbol}] evaluation failed:`, message);
      insertSignalLog({
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        technicalTriggerPassed: false,
        onchainConfluencePresent: false,
        actionTaken: "none",
        detail: JSON.stringify({ error: message }),
      });
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
