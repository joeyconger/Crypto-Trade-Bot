import { getDb, type TradeRow } from "../db/index.js";
import type { TokenConfig } from "../types/index.js";

/** Simulates a fill at the current price -- no real transaction, paper mode only. */
export function openPaperPosition(token: TokenConfig, currentPrice: number, usdSize: number, reason: string): number {
  const quantity = usdSize / currentPrice;
  const stopLossPrice = currentPrice * (1 - token.stopLossPct / 100);
  const takeProfitPrice = currentPrice * (1 + token.takeProfitPct / 100);

  const result = getDb()
    .prepare(
      `INSERT INTO trades (
        token_address, token_symbol, mode, side, status,
        entry_price, quantity, usd_size, stop_loss_price, take_profit_price, reason
      ) VALUES (?, ?, 'paper', 'buy', 'open', ?, ?, ?, ?, ?, ?)`,
    )
    .run(token.address, token.symbol, currentPrice, quantity, usdSize, stopLossPrice, takeProfitPrice, reason);

  return Number(result.lastInsertRowid);
}

export function closePaperPosition(trade: TradeRow, exitPrice: number, exitReason: string): void {
  const pnlUsd = (exitPrice - trade.entry_price) * trade.quantity;
  const pnlPct = (pnlUsd / trade.usd_size) * 100;

  getDb()
    .prepare(
      `UPDATE trades
       SET status = 'closed', exit_price = ?, pnl_usd = ?, pnl_pct = ?,
           closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           reason = reason || ' | exit: ' || ?
       WHERE id = ?`,
    )
    .run(exitPrice, pnlUsd, pnlPct, exitReason, trade.id);
}
