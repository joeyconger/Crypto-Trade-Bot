export interface PositionSizeResult {
  quantity: number;
  usdSize: number;
  cappedByMaxPosition: boolean;
}

/**
 * Stop-distance-based sizing: risk a fixed % of the account per trade, with
 * the stop distance (not a flat dollar amount) determining how many tokens
 * that buys. Position size = (account x riskPct) / (entry - stop). The max
 * position size is a hard ceiling that overrides the risk formula -- a very
 * tight stop can imply a huge size, and the cap wins regardless, accepting
 * that actual $ risk ends up below riskPct in that case.
 */
export function computePositionSize(
  accountUsd: number,
  entryPrice: number,
  stopPrice: number,
  riskPctPerTrade: number,
  maxPositionSizePct: number,
): PositionSizeResult {
  const stopDistance = entryPrice - stopPrice;
  if (stopDistance <= 0) {
    throw new Error(`Invalid stop distance: entry ${entryPrice} must be above stop ${stopPrice}`);
  }

  const riskUsd = accountUsd * (riskPctPerTrade / 100);
  const rawUsdSize = (riskUsd / stopDistance) * entryPrice;

  const maxUsdSize = accountUsd * (maxPositionSizePct / 100);
  const cappedByMaxPosition = rawUsdSize > maxUsdSize;
  const usdSize = cappedByMaxPosition ? maxUsdSize : rawUsdSize;

  return { quantity: usdSize / entryPrice, usdSize, cappedByMaxPosition };
}

/** Initial stop = the swing low that defined the fib range, minus 1x ATR (configurable multiplier). */
export function computeInitialStop(swingLow: number, atr: number, atrMultiplier: number): number {
  return swingLow - atr * atrMultiplier;
}

export interface TrancheQuantities {
  scale1Qty: number;
  scale2Qty: number;
  runnerQty: number; // remainder after both scale-outs -- the uncapped portion
}

export function computeTrancheQuantities(originalQuantity: number, scaleOutPct1: number, scaleOutPct2: number): TrancheQuantities {
  const scale1Qty = originalQuantity * (scaleOutPct1 / 100);
  const scale2Qty = originalQuantity * (scaleOutPct2 / 100);
  return { scale1Qty, scale2Qty, runnerQty: originalQuantity - scale1Qty - scale2Qty };
}
