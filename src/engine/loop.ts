import { env } from "../config/env.js";
import { loadWatchlistConfig } from "../config/watchlist.js";
import {
  getBotState,
  getOpenTrade,
  getOpenPositionCount,
  getTradeById,
  insertSignalLog,
  insertTradeSignalWallet,
  getLastTechnicalEvalAtMap,
  setLastTechnicalEvalAt,
  type TradeRow,
} from "../db/index.js";
import { resolveWatchlistTokens } from "./watchlistSource.js";
import { getTokenOverview, getMultiPrice, getOhlcv } from "../data/priceProvider.js";
import type { OhlcvCandle } from "../data/types.js";
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
  const timeTo = Math.floor(Date.now() / 1000);
  const timeFrom = timeTo - token.swingLookbackHours * 3600;
  return (await getOhlcv(token.address, token.swingLookbackHours, timeFrom, timeTo)).sort((a, b) => a.unixTime - b.unixTime);
}

async function manageOpenPosition(
  token: TokenConfig,
  config: WatchlistConfig,
  trade: TradeRow,
  currentPrice: number,
  mode: Mode,
): Promise<void> {
  // decideExitAction only reads candles for the runner's structure-trailing
  // stop (its runner_active branch) -- stop/scale-out/time-exit checks are
  // all plain price comparisons. Fetching a full OHLCV history every cycle
  // for every open position regardless of runner state was pure waste.
  const candles = trade.runner_active ? await fetchCandles(token) : [];
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

function logSkip(token: TokenConfig, technicalPassed: boolean, onchainPresent: boolean, detail: Record<string, unknown>): void {
  insertSignalLog({
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    technicalTriggerPassed: technicalPassed,
    onchainConfluencePresent: onchainPresent,
    actionTaken: "none",
    detail: JSON.stringify(detail),
  });
}

/**
 * Conditions 1-6 (technical) narrow WHEN to look; Condition 7 (on-chain
 * confluence) is the required gate on WHETHER to actually enter -- real
 * wallets accumulating real size is the strongest evidence this strategy
 * has, not an optional add-on. A technical setup with no qualifying
 * confirmation never opens a position; there is no technical-only path.
 */
async function considerNewEntry(
  token: TokenConfig,
  config: WatchlistConfig,
  currentPrice: number,
  mode: Mode,
): Promise<void> {
  const openCount = getOpenPositionCount(mode);
  if (openCount >= config.risk.maxConcurrentPositions) {
    logSkip(token, false, false, {
      skipReason: `max concurrent positions reached (${openCount}/${config.risk.maxConcurrentPositions})`,
    });
    return;
  }

  const candles = await fetchCandles(token);
  const technical = evaluateTechnicalTrigger(candles, currentPrice, token);

  if (!technical.passed) {
    logSkip(token, false, false, { skipReason: technical.reason });
    return;
  }

  const atr = computeATR(candles, token.atrPeriod);
  const swing = technical.swing!;
  const stopPrice = atr !== undefined ? computeInitialStop(swing.lowPrice, atr, token.stopAtrMultiplier) : undefined;

  if (atr === undefined || stopPrice === undefined || stopPrice >= currentPrice) {
    logSkip(token, true, false, {
      skipReason: atr === undefined ? "not enough candle history for ATR" : "computed stop is not below entry price",
    });
    return;
  }

  // Fresh liquidity re-check at entry time -- the watchlist's $ floor was
  // set whenever it last refreshed (up to 24h ago); a pool can thin out
  // well before that list next updates. This also feeds the on-chain
  // size-vs-liquidity check below, so one fetch does both jobs.
  let liquidityUsd: number;
  try {
    liquidityUsd = (await getTokenOverview(token.address)).liquidityUsd;
  } catch (err) {
    logSkip(token, true, false, {
      skipReason: `liquidity re-check failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  if (liquidityUsd < config.watchlistSource.minLiquidityUsd) {
    logSkip(token, true, false, {
      skipReason: `current liquidity $${liquidityUsd.toFixed(0)} below the $${config.watchlistSource.minLiquidityUsd} floor (re-checked at entry time, not just at watchlist refresh)`,
    });
    return;
  }

  // Condition 7 -- required, blocking. Unlike the pre-revision build, a
  // failed lookup here blocks the entry rather than silently proceeding.
  let onchain: Awaited<ReturnType<typeof evaluateEntryTrigger>>;
  try {
    onchain = await evaluateEntryTrigger(token, liquidityUsd);
  } catch (err) {
    logSkip(token, true, false, {
      skipReason: `on-chain confluence check failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  if (!onchain.fired) {
    logSkip(token, true, false, { technicalReason: technical.reason, skipReason: onchain.skipReason });
    return;
  }

  const tier = onchain.tier!;
  const confirmingWallets = onchain.confirmingWallets;

  const bankrollUsd = await getBankrollUsd(mode);
  const circuitCheck = checkCircuitBreakers(mode, config.risk, bankrollUsd);
  if (!circuitCheck.allowed) {
    console.log(`[${token.symbol}] technical + on-chain (Tier ${tier}) fired but blocked: ${circuitCheck.reason}`);
    logSkip(token, true, true, { tier, blockedBy: circuitCheck.reason });
    return;
  }

  const riskPct = tier === "A" ? config.risk.riskPctPerTrade : config.risk.riskPctPerTradeTierB;
  const sizing = computePositionSize(bankrollUsd, currentPrice, stopPrice, riskPct, config.risk.maxPositionSizePct);
  const extensions = computeFibExtensions(swing, [token.extensionRatio1, token.extensionRatio2]);

  const reason = `${technical.reason} + on-chain confluence (Tier ${tier}): ${confirmingWallets.length} confirming wallet(s)`;

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
    confluenceTier: tier,
    reason,
  };

  let tradeId: number;
  try {
    tradeId = mode === "live" ? await openLivePosition(plan) : openPaperPosition(plan, currentPrice);
  } catch (err) {
    console.error(`[${token.symbol}] failed to open position:`, err instanceof Error ? err.message : err);
    logSkip(token, true, true, { tier, error: err instanceof Error ? err.message : String(err) });
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
    `[${token.symbol}] opened ${mode} position #${tradeId}: $${sizing.usdSize.toFixed(2)} @ ${currentPrice} (stop ${stopPrice.toFixed(6)}, tier ${tier}, risk ${riskPct}%, cap-limited=${sizing.cappedByMaxPosition})`,
  );

  insertSignalLog({
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    technicalTriggerPassed: true,
    onchainConfluencePresent: true,
    actionTaken: "buy",
    detail: JSON.stringify({
      technicalReason: technical.reason,
      tier,
      confirmingWallets: confirmingWallets.map((w) => w.walletAddress),
      fibZoneLevel: technical.matchedLevel?.level,
      atr,
      stopPrice,
      liquidityUsd,
    }),
    tradeId,
  });
}

async function evaluateAndActOnToken(
  token: TokenConfig,
  config: WatchlistConfig,
  mode: Mode,
  currentPrice: number,
): Promise<void> {
  // Record all observed wallet activity first -- feeds both on-chain
  // confluence and the wallet reputation that improves as the bot runs.
  await pollWalletActivity(token, currentPrice);

  const openTrade = getOpenTrade(token.address, mode);

  if (openTrade) {
    await manageOpenPosition(token, config, openTrade, currentPrice, mode);
  } else {
    await considerNewEntry(token, config, currentPrice, mode);
  }
}

// Gap between tokens in the PRIORITY lane (open positions + due pinned
// tokens) -- always a small, fixed count, so a small fixed gap keeps them
// responsive without meaningfully touching the rate limit. The DYNAMIC
// lane's gap is computed per-cycle instead -- see spreadDynamicLane below.
export const TOKEN_STAGGER_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ScanPlan {
  priority: TokenConfig[]; // open positions + due pinned tokens -- always processed promptly
  dynamic: TokenConfig[]; // budgeted slice of due dynamic tokens -- spread across the tick
  dynamicDueCount: number;
  dynamicBudget: number;
  maxDynamicStalenessMinutes: number | undefined; // largest "time since last eval" across the WHOLE dynamic pool, for cadence visibility
}

/**
 * Splits due tokens into two lanes instead of returning one flat list:
 *
 * - priority: open positions (always managed -- stop/trailing tracking must
 *   stay current) plus due pinned tokens (only 2 by default, trivial cost).
 * - dynamic: due tokens from the top-N watchlist, budgeted and sorted
 *   oldest-evaluated-first. The budget is sized so that, spread evenly
 *   across every tick within one technicalRefreshIntervalMinutes window,
 *   the WHOLE dynamic pool gets covered roughly once per window -- instead
 *   of trying to scan all of them the moment they're simultaneously due,
 *   which is what caused rate-limit bursts before. Oldest-first ordering
 *   means any backlog (a skipped cycle, a slow provider) self-heals: the
 *   most-overdue tokens always get priority for the next available budget.
 */
function planScan(allTokens: TokenConfig[], config: WatchlistConfig, mode: Mode): ScanPlan {
  const lastEvalMap = getLastTechnicalEvalAtMap();
  const now = Date.now();
  const pinnedAddresses = new Set(config.tokens.map((t) => t.address));

  const isDue = (token: TokenConfig): boolean => {
    const lastEvalAt = lastEvalMap.get(token.address);
    if (!lastEvalAt) return true;
    return now >= new Date(lastEvalAt).getTime() + token.technicalRefreshIntervalMinutes * 60 * 1000;
  };

  const priority: TokenConfig[] = [];
  const dueDynamic: TokenConfig[] = [];

  for (const token of allTokens) {
    if (getOpenTrade(token.address, mode)) {
      priority.push(token);
      continue;
    }
    if (!isDue(token)) continue;
    if (pinnedAddresses.has(token.address)) {
      priority.push(token);
    } else {
      dueDynamic.push(token);
    }
  }

  let dynamicBudget = dueDynamic.length;
  if (config.watchlistSource.mode === "top_traded" && config.defaultStrategy) {
    const windowSeconds = config.defaultStrategy.technicalRefreshIntervalMinutes * 60;
    const ticksPerWindow = Math.max(1, Math.floor(windowSeconds / env.POLL_INTERVAL_SECONDS));
    dynamicBudget = Math.max(1, Math.ceil(config.watchlistSource.topTradedCount / ticksPerWindow));
  }

  dueDynamic.sort((a, b) => {
    const aAt = lastEvalMap.get(a.address);
    const bAt = lastEvalMap.get(b.address);
    if (!aAt && !bAt) return 0;
    if (!aAt) return -1; // never-evaluated goes first
    if (!bAt) return 1;
    return new Date(aAt).getTime() - new Date(bAt).getTime(); // oldest first
  });

  let maxDynamicStalenessMinutes: number | undefined;
  for (const token of allTokens) {
    if (pinnedAddresses.has(token.address)) continue;
    const lastEvalAt = lastEvalMap.get(token.address);
    const stalenessMinutes = lastEvalAt ? (now - new Date(lastEvalAt).getTime()) / 60000 : Infinity;
    if (maxDynamicStalenessMinutes === undefined || stalenessMinutes > maxDynamicStalenessMinutes) {
      maxDynamicStalenessMinutes = stalenessMinutes;
    }
  }

  return {
    priority,
    dynamic: dueDynamic.slice(0, dynamicBudget),
    dynamicDueCount: dueDynamic.length,
    dynamicBudget,
    maxDynamicStalenessMinutes,
  };
}

async function processTokenBatch(
  tokens: TokenConfig[],
  config: WatchlistConfig,
  mode: Mode,
  priceMap: Map<string, number>,
  staggerMs: number,
): Promise<void> {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (i > 0) await sleep(staggerMs);

    try {
      const currentPrice = priceMap.get(token.address) ?? (await getTokenOverview(token.address)).price;
      const hadOpenTrade = !!getOpenTrade(token.address, mode);

      await evaluateAndActOnToken(token, config, mode, currentPrice);

      // Only stamp the throttle for tokens evaluated because they were DUE,
      // not ones swept in because they had an open position -- an open
      // position's presence in this cycle isn't a technical re-evaluation.
      if (!hadOpenTrade) {
        setLastTechnicalEvalAt(token.address, new Date().toISOString());
      }
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

export async function runPollCycle(): Promise<void> {
  if (getBotState().paused) {
    console.log("Bot is paused -- skipping poll cycle");
    return;
  }

  const config = loadWatchlistConfig();
  const mode: Mode = env.liveTradingEnabled ? "live" : "paper";

  const allTokens = await resolveWatchlistTokens(config);
  const plan = planScan(allTokens, config, mode);

  if (plan.priority.length === 0 && plan.dynamic.length === 0) return;

  const priceMap = await getMultiPrice([...plan.priority, ...plan.dynamic].map((t) => t.address)).catch((err) => {
    console.error("Batched price fetch failed, falling back to per-token lookups:", err instanceof Error ? err.message : err);
    return new Map<string, number>();
  });

  // Priority lane first, with the small fixed stagger -- open positions and
  // the couple of pinned tokens stay responsive regardless of what else is
  // happening this cycle.
  await processTokenBatch(plan.priority, config, mode, priceMap, TOKEN_STAGGER_MS);

  // Dynamic lane spread across most of the remaining tick duration instead
  // of a fixed small gap -- this is what turns "scan the due batch as fast
  // as possible" (bursty, rate-limit risk) into "scan steadily throughout
  // the window" (smooth, well under the limit).
  if (plan.dynamic.length > 0) {
    const tickMs = env.POLL_INTERVAL_SECONDS * 1000;
    const spreadMs = Math.max(TOKEN_STAGGER_MS, Math.floor((tickMs * 0.8) / plan.dynamic.length));
    await processTokenBatch(plan.dynamic, config, mode, priceMap, spreadMs);
  }

  if (config.watchlistSource.mode === "top_traded" && config.defaultStrategy) {
    const targetMinutes = config.defaultStrategy.technicalRefreshIntervalMinutes;
    const staleness = plan.maxDynamicStalenessMinutes;
    const stalenessStr =
      staleness === undefined ? "n/a" : Number.isFinite(staleness) ? `${staleness.toFixed(1)}min` : "never evaluated yet";
    const withinTarget = staleness !== undefined && Number.isFinite(staleness) && staleness <= targetMinutes * 1.5;
    console.log(
      `watchlist cadence: ${plan.dynamic.length}/${plan.dynamicDueCount} due dynamic tokens processed this cycle ` +
        `(budget ${plan.dynamicBudget}), ${plan.priority.length} priority tokens; oldest dynamic token staleness ` +
        `${stalenessStr} (target <=${targetMinutes}min)${withinTarget ? "" : " -- FALLING BEHIND"}`,
    );
  }
}

/**
 * Self-rescheduling, not setInterval: a cycle only starts intervalSeconds
 * after the PREVIOUS one finished, never before. With a couple of tokens
 * this never mattered (a cycle takes seconds); with a large watchlist,
 * setInterval would happily fire the next cycle before the current one
 * finishes, compounding the API load this is already tight on.
 */
export function startPollLoop(intervalSeconds: number): { stop: () => void } {
  console.log(`Starting poll loop (every ${intervalSeconds}s)`);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    const startedAt = Date.now();
    try {
      await runPollCycle();
    } catch (err) {
      console.error("Poll cycle failed:", err);
    }
    if (stopped) return;

    const elapsedMs = Date.now() - startedAt;
    const delayMs = Math.max(0, intervalSeconds * 1000 - elapsedMs);
    timer = setTimeout(tick, delayMs);
  };

  tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
