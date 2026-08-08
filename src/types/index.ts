export interface TokenConfig {
  symbol: string;
  address: string;
  enabled: boolean;

  // fib filter (only ever evaluated after the on-chain trigger fires)
  fibPivotWindow: number; // candles on each side to confirm a swing pivot
  goldenPocketZonePct: number; // % proximity to the 0.5/0.618 retracement to count as "at" it
  swingLookbackHours: number; // how much OHLCV history to fetch for pivot detection

  // on-chain entry trigger (the only signal that can trigger a trade)
  minBuyUsd: number;
  maxBuyPctOfLiquidity: number;
  minWalletAgeDays: number;
  minWalletPriorTrades: number;
  confirmationWindowHours: number;
  minConfirmingWallets: number;

  // ATR-based stop
  atrPeriod: number;
  stopAtrMultiplier: number;

  // scaled take-profit (fib extensions)
  extensionRatio1: number;
  extensionRatio2: number;
  scaleOutPct1: number;
  scaleOutPct2: number; // remainder after both scale-outs is the uncapped runner

  // time-based exit, unscaled portion only
  timeExitHours: number;
}

export interface RiskConfig {
  riskPctPerTrade: number; // % of account risked per trade -- drives position size, not a flat $ amount
  maxPositionSizePct: number; // hard ceiling on position size regardless of stop distance
  dailyLossLimitPct: number; // halt new entries for the rest of the UTC day
  weeklyLossLimitPct: number; // halt entirely, sticky until manually resumed
  consecutiveLossLimit: number; // halt entirely, sticky until manually resumed
}

export interface WatchlistConfig {
  tokens: TokenConfig[];
  risk: RiskConfig;
}
