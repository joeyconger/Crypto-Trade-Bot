import type { ParsedSwap } from "./parseSwap.js";
import type { TailConfig } from "./config.js";
import { resolveTokenSymbol } from "../data/resolveTokenSymbol.js";
import { getTokenOverview } from "../data/priceProvider.js";
import { simulateDelayedFill, getQuoteUsdPrice } from "./simulateFill.js";
import { executeLiveBuy, executeLiveSell } from "./liveExecution.js";
import { getBotWalletBalanceUsd } from "../execution/liveTrading.js";
import {
  insertPendingTailEntry,
  recordEntryFill,
  markEntryUnfillable,
  getOpenTailTrade,
  recordExitDetection,
  recordExitFill,
  markExitUnfillable,
  insertTailWebhookLog,
} from "./db.js";

/**
 * Turns one detected buy/sell into a mirrored trade -- paper (simulated
 * delay + price lookup) or live (a real Jupiter swap), depending on
 * config.liveTradingEnabled. Both handlers are meant to be called
 * fire-and-forget (not awaited) from the webhook handler -- paper mode
 * includes the full simulated pipeline delay (TAIL_SIMULATED_DELAY_SECONDS)
 * and live mode includes real swap latency, so awaiting either before
 * responding to the webhook would hold that HTTP request open, risking the
 * provider treating it as a failed delivery and retrying. See src/tail/webhook.ts.
 */

/** Best-effort liquidity/market-cap lookup for a live fill's display context -- the swap itself already succeeded regardless, so a failure here just leaves those fields blank rather than blocking the trade record. */
async function tryGetLiquidityAndMcap(tokenAddress: string): Promise<{ liquidityUsd: number | undefined; marketCapUsd: number | undefined }> {
  try {
    const overview = await getTokenOverview(tokenAddress);
    return { liquidityUsd: overview.liquidityUsd, marketCapUsd: overview.marketCapUsd };
  } catch {
    return { liquidityUsd: undefined, marketCapUsd: undefined };
  }
}

export async function handleParsedBuy(
  swap: ParsedSwap,
  walletAddress: string,
  detectedAt: Date,
  config: TailConfig,
): Promise<void> {
  const existing = getOpenTailTrade(walletAddress, swap.tokenAddress);
  if (existing) {
    insertTailWebhookLog(
      walletAddress,
      swap.txSignature,
      "ignored_already_open",
      `already has an open tail_trade (id ${existing.id}) for this token -- position averaging isn't modeled in v1, ignoring this buy`,
    );
    return;
  }

  const quote = await getQuoteUsdPrice(swap.quoteMint, swap.quoteIsStable);
  if (!quote.ok) {
    insertTailWebhookLog(
      walletAddress,
      swap.txSignature,
      "parse_error",
      `detected a buy but couldn't price the quote leg (mint ${swap.quoteMint}) in USD: ${quote.error} -- trade not recorded`,
    );
    return;
  }

  const walletEntryPriceUsd = (swap.quoteAmount * quote.priceUsd) / swap.tokenAmount;
  // Live sizing is a % of the wallet's REAL current balance; paper sizing is
  // a % of the fictional TAIL_STARTING_BALANCE_USD -- these are deliberately
  // different bases, not interchangeable.
  const usdSize = config.liveTradingEnabled
    ? ((await getBotWalletBalanceUsd()) * config.positionSizePct) / 100
    : (config.startingBalanceUsd * config.positionSizePct) / 100;
  const entryDetectionLatencyMs = detectedAt.getTime() - new Date(swap.onchainAt).getTime();

  const tradeId = insertPendingTailEntry({
    walletAddress,
    tokenAddress: swap.tokenAddress,
    tokenSymbol: await resolveTokenSymbol(swap.tokenAddress),
    usdSize,
    walletEntryPriceUsd,
    walletEntryTxSignature: swap.txSignature,
    walletEntryOnchainAt: swap.onchainAt,
    entryDetectedAt: detectedAt.toISOString(),
    entryDetectionLatencyMs,
    isLive: config.liveTradingEnabled,
  });

  insertTailWebhookLog(
    walletAddress,
    swap.txSignature,
    "parsed_buy",
    `tail_trade ${tradeId} opened (pending ${config.liveTradingEnabled ? "live swap" : "sim fill"})`,
  );

  if (config.liveTradingEnabled) {
    const result = await executeLiveBuy(swap.tokenAddress, usdSize);
    if (!result.ok) {
      markEntryUnfillable(tradeId);
      insertTailWebhookLog(walletAddress, swap.txSignature, "parse_error", `tail_trade ${tradeId}: live buy failed -- marked unfillable_entry: ${result.reason}`);
      return;
    }
    const { liquidityUsd, marketCapUsd } = await tryGetLiquidityAndMcap(swap.tokenAddress);
    recordEntryFill({
      tradeId,
      simEntryFillAt: new Date().toISOString(),
      simEntryFillPriceUsd: result.fillPriceUsd,
      entryLiquidityUsd: liquidityUsd,
      entryMarketCapUsd: marketCapUsd,
      quantity: result.quantity,
      ownEntryTxSignature: result.signature,
    });
    return;
  }

  const fill = await simulateDelayedFill(swap.tokenAddress, config.simulatedDelaySeconds);
  if (!fill.ok) {
    markEntryUnfillable(tradeId);
    insertTailWebhookLog(
      walletAddress,
      swap.txSignature,
      "parse_error",
      `tail_trade ${tradeId}: no usable price at simulated fill time (${config.simulatedDelaySeconds}s after detection) -- marked unfillable_entry: ${fill.error}`,
    );
    return;
  }

  recordEntryFill({
    tradeId,
    simEntryFillAt: new Date().toISOString(),
    simEntryFillPriceUsd: fill.priceUsd,
    entryLiquidityUsd: fill.liquidityUsd,
    entryMarketCapUsd: fill.marketCapUsd,
    quantity: usdSize / fill.priceUsd,
  });
}

export async function handleParsedSell(
  swap: ParsedSwap,
  walletAddress: string,
  detectedAt: Date,
  config: TailConfig,
): Promise<void> {
  const open = getOpenTailTrade(walletAddress, swap.tokenAddress);
  if (!open) {
    insertTailWebhookLog(
      walletAddress,
      swap.txSignature,
      "ignored_no_open_position",
      `detected a sell with no matching open tail_trade for this token -- likely started tailing after this position was opened, or the entry was unfillable`,
    );
    return;
  }

  const quote = await getQuoteUsdPrice(swap.quoteMint, swap.quoteIsStable);
  if (!quote.ok) {
    insertTailWebhookLog(
      walletAddress,
      swap.txSignature,
      "parse_error",
      `detected the sell closing tail_trade ${open.id} but couldn't price the quote leg (mint ${swap.quoteMint}) in USD: ${quote.error} -- position left open, exit not recorded`,
    );
    return;
  }

  const walletExitPriceUsd = (swap.quoteAmount * quote.priceUsd) / swap.tokenAmount;
  const exitDetectionLatencyMs = detectedAt.getTime() - new Date(swap.onchainAt).getTime();

  recordExitDetection({
    tradeId: open.id,
    walletExitPriceUsd,
    walletExitTxSignature: swap.txSignature,
    walletExitOnchainAt: swap.onchainAt,
    exitDetectedAt: detectedAt.toISOString(),
    exitDetectionLatencyMs,
  });

  insertTailWebhookLog(
    walletAddress,
    swap.txSignature,
    "parsed_sell",
    `tail_trade ${open.id} exit detected (pending ${open.is_live ? "live swap" : "sim fill"})`,
  );

  if (open.is_live) {
    const result = await executeLiveSell(swap.tokenAddress);
    if (!result.ok) {
      markExitUnfillable(open.id);
      insertTailWebhookLog(walletAddress, swap.txSignature, "parse_error", `tail_trade ${open.id}: live sell failed -- marked unfillable_exit (needs manual review): ${result.reason}`);
      return;
    }
    const { liquidityUsd, marketCapUsd } = await tryGetLiquidityAndMcap(swap.tokenAddress);
    recordExitFill({
      tradeId: open.id,
      simExitFillAt: new Date().toISOString(),
      simExitFillPriceUsd: result.fillPriceUsd,
      exitLiquidityUsd: liquidityUsd,
      exitMarketCapUsd: marketCapUsd,
      ownExitTxSignature: result.signature,
    });
    return;
  }

  const fill = await simulateDelayedFill(swap.tokenAddress, config.simulatedDelaySeconds);
  if (!fill.ok) {
    markExitUnfillable(open.id);
    insertTailWebhookLog(
      walletAddress,
      swap.txSignature,
      "parse_error",
      `tail_trade ${open.id}: no usable price at simulated exit fill time -- marked unfillable_exit (left open, needs manual review): ${fill.error}`,
    );
    return;
  }

  recordExitFill({
    tradeId: open.id,
    simExitFillAt: new Date().toISOString(),
    simExitFillPriceUsd: fill.priceUsd,
    exitLiquidityUsd: fill.liquidityUsd,
    exitMarketCapUsd: fill.marketCapUsd,
  });
}
