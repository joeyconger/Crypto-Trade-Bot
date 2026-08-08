import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  insertTrade,
  insertPositionExit,
  markScaleOut1Done,
  markScaleOut2Done,
  closeTradeFully,
  type TradeRow,
  type PlannedTradeInput,
} from "../db/index.js";
import { getTokenOverview } from "../data/birdeye.js";
import { getConnection } from "../solana/connection.js";
import { getBotKeypair } from "../solana/keypair.js";
import { getTokenBalanceRaw } from "../solana/tokenAccounts.js";
import { swapSolForToken, swapTokenForSol, SOL_MINT } from "./jupiter.js";
import { computeTrancheQuantities } from "./positionSizing.js";

const FEE_RESERVE_SOL = 0.01;

export async function getBotSolBalance(): Promise<number> {
  const connection = getConnection();
  const keypair = getBotKeypair();
  const lamports = await connection.getBalance(keypair.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

export async function getBotWalletBalanceUsd(): Promise<number> {
  const [solBalance, solOverview] = await Promise.all([getBotSolBalance(), getTokenOverview(SOL_MINT)]);
  return solBalance * solOverview.price;
}

/**
 * Swaps SOL -> token via Jupiter, signs with the bot's own keypair, and
 * records the fill. Quantity received is read back from the actual on-chain
 * balance delta (not the quote's outAmount/decimals) so it's correct
 * regardless of any pre-existing dust in the wallet.
 */
export async function openLivePosition(plan: PlannedTradeInput): Promise<number> {
  const solOverview = await getTokenOverview(SOL_MINT);
  const solAmount = plan.usdSize / solOverview.price;

  const solBalance = await getBotSolBalance();
  if (solAmount + FEE_RESERVE_SOL > solBalance) {
    throw new Error(
      `Insufficient SOL balance for ${plan.tokenSymbol}: need ~${solAmount.toFixed(4)} + ${FEE_RESERVE_SOL} fee reserve, have ${solBalance.toFixed(4)}`,
    );
  }

  const before = await getTokenBalanceRaw(plan.tokenAddress);
  const result = await swapSolForToken(plan.tokenAddress, solAmount);
  const after = await getTokenBalanceRaw(plan.tokenAddress);

  const quantity = (after?.uiAmount ?? 0) - (before?.uiAmount ?? 0);
  if (quantity <= 0) {
    throw new Error(`Swap ${result.signature} confirmed but ${plan.tokenSymbol} balance didn't increase`);
  }

  const entryPrice = plan.usdSize / quantity;

  return insertTrade({ ...plan, mode: "live", entryPrice, quantity, txSignature: result.signature });
}

/**
 * Sells a specific target quantity by computing what fraction of the
 * wallet's CURRENT on-chain balance that represents, then selling that
 * fraction of the actual raw amount -- avoids drift between our recorded
 * quantity and on-chain reality across multiple partial exits. The fraction
 * itself goes through floating point (harmless -- a 33%-ish tranche doesn't
 * need more than a few decimal places of precision); the raw amount stays in
 * BigInt throughout so large token supplies never lose integer precision.
 */
async function sellFractionOfBalance(
  tokenAddress: string,
  targetQuantity: number,
): Promise<{ signature: string; quantitySold: number; usdReceived: number }> {
  const balance = await getTokenBalanceRaw(tokenAddress);
  if (!balance || balance.uiAmount <= 0) {
    throw new Error(`No on-chain balance found for ${tokenAddress}`);
  }

  const fraction = Math.min(1, targetQuantity / balance.uiAmount);
  const fractionBps = BigInt(Math.round(fraction * 10_000));
  const rawAmountToSell = ((BigInt(balance.amountRaw) * fractionBps) / 10_000n).toString();

  const result = await swapTokenForSol(tokenAddress, rawAmountToSell);
  const solOverview = await getTokenOverview(SOL_MINT);
  const solReceived = Number(result.outAmount) / LAMPORTS_PER_SOL;

  return { signature: result.signature, quantitySold: balance.uiAmount * fraction, usdReceived: solReceived * solOverview.price };
}

/** The 33% (configurable) partial exit at an extension target. Trade stays open -- quantity_remaining just drops. */
export async function executeLiveScaleOut(
  trade: TradeRow,
  tranche: "scale_1" | "scale_2",
  exitReason: string,
  scaleOutPct1: number,
  scaleOutPct2: number,
): Promise<void> {
  const { scale1Qty, scale2Qty } = computeTrancheQuantities(trade.quantity, scaleOutPct1, scaleOutPct2);
  const targetQty = tranche === "scale_1" ? scale1Qty : scale2Qty;

  const { signature, quantitySold, usdReceived } = await sellFractionOfBalance(trade.token_address, targetQty);
  const exitPrice = quantitySold > 0 ? usdReceived / quantitySold : 0;
  const pnlUsd = usdReceived - quantitySold * trade.entry_price;

  insertPositionExit({
    tradeId: trade.id,
    tranche,
    quantity: quantitySold,
    exitPrice,
    exitReason,
    pnlUsd,
    txSignature: signature,
  });

  if (tranche === "scale_1") {
    markScaleOut1Done(trade.id, trade.quantity_remaining - quantitySold);
  } else {
    markScaleOut2Done(trade.id, trade.quantity_remaining - quantitySold, trade.entry_price); // moves stop to breakeven, activates the runner
  }
}

/**
 * Sells the wallet's full remaining on-chain balance of the token, for any
 * reason other than hitting an extension target -- logged as the 'runner'
 * tranche whether it's actually the trailing runner or the full original
 * position closing before any scale-out ever fired.
 */
export async function closeLivePositionRemainder(trade: TradeRow, exitReason: string): Promise<void> {
  const balance = await getTokenBalanceRaw(trade.token_address);
  if (!balance || balance.amountRaw === "0") {
    throw new Error(`No on-chain balance found for ${trade.token_symbol} -- cannot close live position #${trade.id}`);
  }

  const result = await swapTokenForSol(trade.token_address, balance.amountRaw);
  const solOverview = await getTokenOverview(SOL_MINT);
  const solReceived = Number(result.outAmount) / LAMPORTS_PER_SOL;
  const usdReceived = solReceived * solOverview.price;
  const quantitySold = balance.uiAmount;
  const exitPrice = quantitySold > 0 ? usdReceived / quantitySold : 0;

  insertPositionExit({
    tradeId: trade.id,
    tranche: "runner",
    quantity: quantitySold,
    exitPrice,
    exitReason,
    pnlUsd: usdReceived - quantitySold * trade.entry_price,
    txSignature: result.signature,
  });
  closeTradeFully(trade.id);
}
