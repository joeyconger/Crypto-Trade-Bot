import type { ParsedSwap } from "./parseSwap.js";
import type { TailConfig } from "./config.js";
import { getTokenOverview } from "../data/priceProvider.js";
import { simulateDelayedFill, getQuoteUsdPrice } from "./simulateFill.js";
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
 * Turns one detected buy/sell into a mirrored paper trade. Both handlers are
 * meant to be called fire-and-forget (not awaited) from the webhook handler
 * -- they include the full simulated pipeline delay (TAIL_SIMULATED_DELAY_SECONDS),
 * so awaiting them before responding to the webhook would hold that HTTP
 * request open for the entire delay, risking the provider treating it as a
 * failed delivery and retrying. See src/tail/webhook.ts.
 */

async function tokenSymbolFor(tokenAddress: string): Promise<string> {
  // Best-effort real ticker via the same getTokenOverview call already used
  // for pricing elsewhere -- this is a SEPARATE network call from the
  // simulated-fill lookup (that one runs after the delay, this one runs
  // immediately), but at this module's trade volume that's a negligible
  // cost against a much more useful dashboard/table label. Falls back to a
  // shortened address if the provider errors or has no symbol for this
  // token (never blocks opening the trade over a missing display label).
  try {
    const overview = await getTokenOverview(tokenAddress);
    if (overview.symbol) return overview.symbol;
  } catch {
    // fall through
  }
  return `${tokenAddress.slice(0, 4)}…${tokenAddress.slice(-4)}`;
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
  const usdSize = (config.startingBalanceUsd * config.positionSizePct) / 100;
  const entryDetectionLatencyMs = detectedAt.getTime() - new Date(swap.onchainAt).getTime();

  const tradeId = insertPendingTailEntry({
    walletAddress,
    tokenAddress: swap.tokenAddress,
    tokenSymbol: await tokenSymbolFor(swap.tokenAddress),
    usdSize,
    walletEntryPriceUsd,
    walletEntryTxSignature: swap.txSignature,
    walletEntryOnchainAt: swap.onchainAt,
    entryDetectedAt: detectedAt.toISOString(),
    entryDetectionLatencyMs,
  });

  insertTailWebhookLog(walletAddress, swap.txSignature, "parsed_buy", `tail_trade ${tradeId} opened (pending sim fill)`);

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

  insertTailWebhookLog(walletAddress, swap.txSignature, "parsed_sell", `tail_trade ${open.id} exit detected (pending sim fill)`);

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
