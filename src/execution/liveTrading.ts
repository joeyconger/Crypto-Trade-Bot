import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getDb, type TradeRow } from "../db/index.js";
import { getTokenOverview } from "../data/birdeye.js";
import { getConnection } from "../solana/connection.js";
import { getBotKeypair } from "../solana/keypair.js";
import { getTokenBalanceRaw } from "../solana/tokenAccounts.js";
import { swapSolForToken, swapTokenForSol, SOL_MINT } from "./jupiter.js";
import type { TokenConfig } from "../types/index.js";

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
export async function openLivePosition(token: TokenConfig, usdSize: number, reason: string): Promise<number> {
  const solOverview = await getTokenOverview(SOL_MINT);
  const solAmount = usdSize / solOverview.price;

  const solBalance = await getBotSolBalance();
  if (solAmount + FEE_RESERVE_SOL > solBalance) {
    throw new Error(
      `Insufficient SOL balance for ${token.symbol}: need ~${solAmount.toFixed(4)} + ${FEE_RESERVE_SOL} fee reserve, have ${solBalance.toFixed(4)}`,
    );
  }

  const before = await getTokenBalanceRaw(token.address);
  const result = await swapSolForToken(token.address, solAmount);
  const after = await getTokenBalanceRaw(token.address);

  const quantity = (after?.uiAmount ?? 0) - (before?.uiAmount ?? 0);
  if (quantity <= 0) {
    throw new Error(`Swap ${result.signature} confirmed but ${token.symbol} balance didn't increase`);
  }

  const entryPrice = usdSize / quantity;
  const stopLossPrice = entryPrice * (1 - token.stopLossPct / 100);
  const takeProfitPrice = entryPrice * (1 + token.takeProfitPct / 100);

  const insert = getDb()
    .prepare(
      `INSERT INTO trades (
        token_address, token_symbol, mode, side, status,
        entry_price, quantity, usd_size, stop_loss_price, take_profit_price, reason, tx_signature
      ) VALUES (?, ?, 'live', 'buy', 'open', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(token.address, token.symbol, entryPrice, quantity, usdSize, stopLossPrice, takeProfitPrice, reason, result.signature);

  return Number(insert.lastInsertRowid);
}

/** Sells the wallet's full on-chain balance of the token back to SOL and closes the trade row. */
export async function closeLivePosition(trade: TradeRow, exitReason: string): Promise<void> {
  const balance = await getTokenBalanceRaw(trade.token_address);
  if (!balance || balance.amountRaw === "0") {
    throw new Error(`No on-chain balance found for ${trade.token_symbol} -- cannot close live position #${trade.id}`);
  }

  const result = await swapTokenForSol(trade.token_address, balance.amountRaw);

  const solOverview = await getTokenOverview(SOL_MINT);
  const solReceived = Number(result.outAmount) / LAMPORTS_PER_SOL;
  const usdReceived = solReceived * solOverview.price;

  const exitPrice = usdReceived / trade.quantity;
  const pnlUsd = usdReceived - trade.usd_size;
  const pnlPct = (pnlUsd / trade.usd_size) * 100;

  getDb()
    .prepare(
      `UPDATE trades
       SET status = 'closed', exit_price = ?, pnl_usd = ?, pnl_pct = ?,
           closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           reason = reason || ' | exit: ' || ?,
           tx_signature = tx_signature || ' -> ' || ?
       WHERE id = ?`,
    )
    .run(exitPrice, pnlUsd, pnlPct, exitReason, result.signature, trade.id);
}
