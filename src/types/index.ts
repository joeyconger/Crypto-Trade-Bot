/** "A" = 2+ mutually-unconnected confirming wallets. "B" = 1 wallet clearing the raised solo bar. See onchain/entryTrigger.ts. */
export type ConfluenceTier = "A" | "B";

/** The shared strategy parameters -- everything about HOW to trade a token, independent of WHICH token. */
export interface StrategyConfig {
  // Technical filter -- Conditions 1-6, entry-TIMING only. Fires on trend +
  // fib/structural confluence + RSI momentum + volume + confirmed candle
  // close. Necessary but no longer sufficient on its own -- see the
  // required on-chain confluence gate below.
  fibPivotWindow: number; // candles on each side to confirm a swing pivot
  goldenPocketZonePct: number; // % proximity to the 0.5/0.618 retracement (and to a prior pivot for structural confluence) to count as "at" it
  swingLookbackHours: number; // how much OHLCV history to fetch for pivot/indicator calculation

  trendSmaPeriod: number; // price must be above this SMA -- don't fight the trend
  chopLookbackPeriods: number; // window to count MA crossings in
  chopMaxCrossings: number; // >= this many crossings in the window means "too choppy," skip

  rsiPeriod: number;
  rsiMidline: number; // RSI must be below this and rising -- "turning up," not yet overbought
  rsiOverboughtCeiling: number; // RSI above this means chasing, not catching a pullback

  volumeAvgPeriod: number;
  volumeConfirmationMultiplier: number; // reaction candle volume must be >= this x the average

  // On-chain confluence -- Condition 7, REQUIRED. The strongest evidence in
  // this strategy: real wallets accumulating real size, not just a chart
  // pattern. A technical setup with no qualifying on-chain confirmation
  // never opens a position (see onchain/entryTrigger.ts). Confirmation
  // tiers (src/onchain/entryTrigger.ts):
  //   Tier A: >= 2 mutually-unconnected qualifying wallets.
  //   Tier B: exactly 1 qualifying wallet, but it must additionally clear a
  //     raised bar (reputation >= neutral AND >= soloConfirmationMinPriorTrades
  //     prior trades) to compensate for having no independent corroboration.
  minBuyPctOfLiquidity: number; // buy must be >= this % of current pool liquidity to count as real size, not dust
  maxBuyPctOfLiquidity: number; // buys above this % are treated as manipulation risk, not conviction
  minWalletAgeDays: number;
  minWalletPriorTrades: number; // base per-wallet bar (applies to every candidate, including Tier A wallets)
  soloConfirmationMinPriorTrades: number; // raised bar a LONE confirming wallet must clear for Tier B
  confirmationWindowHours: number;
  minConfirmingWallets: number; // absolute floor on confirmed wallets to fire at all (1 permits Tier B; 2 would disable it)

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

  // Minimum gap between technical-trigger evaluations (OHLCV fetch + fib/
  // RSI/volume/close checks) for a token with no open position. Keeps a
  // large watchlist's API cost bounded independent of poll interval -- a
  // position that IS open is always managed every cycle regardless of this,
  // since stop/trailing tracking needs to stay current.
  technicalRefreshIntervalMinutes: number;
}

/** WHICH token, plus its strategy -- dynamically-selected tokens get the shared defaultStrategy merged in. */
export interface TokenConfig extends StrategyConfig {
  symbol: string;
  address: string;
  enabled: boolean;
}

export interface RiskConfig {
  riskPctPerTrade: number; // % of account risked per trade for a Tier A (2+ wallet) entry
  riskPctPerTradeTierB: number; // % risked for a Tier B (single-wallet, raised-bar) entry -- smaller bet on weaker evidence
  maxPositionSizePct: number; // hard ceiling on position size regardless of stop distance
  dailyLossLimitPct: number; // halt new entries for the rest of the UTC day
  weeklyLossLimitPct: number; // halt entirely, sticky until manually resumed
  consecutiveLossLimit: number; // halt entirely, sticky until manually resumed
  maxConcurrentPositions: number; // hard cap on simultaneously open positions -- checked before every new entry
}

/**
 * "static": trade exactly the tokens listed in `tokens`, hand-tuned per token.
 * "top_traded": trade the top `topTradedCount` tokens by 24h volume from
 * Birdeye, re-selected every `refreshIntervalHours`, each using
 * `defaultStrategy` (100 tokens can't realistically get individually hand-tuned
 * params) -- `tokens` still works alongside this as an always-included pin list.
 */
export interface WatchlistSourceConfig {
  mode: "static" | "top_traded";
  topTradedCount: number;
  refreshIntervalHours: number;
  minLiquidityUsd: number; // filters out illiquid/likely-wash-traded tokens even if volume ranks them highly -- enforced at selection time AND re-checked at entry time
  minTokenAgeHours: number; // excludes pools younger than this from dynamic selection -- the most manipulable, least statistically meaningful class of token
}

export interface WatchlistConfig {
  tokens: TokenConfig[];
  risk: RiskConfig;
  watchlistSource: WatchlistSourceConfig;
  defaultStrategy: StrategyConfig;
}
