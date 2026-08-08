export interface TokenWeights {
  technical: number;
  onchain: number;
  social: number;
}

export interface TokenConfig {
  symbol: string;
  address: string;
  enabled: boolean;

  fibLevels: number[];
  swingLookbackHours: number;
  confluenceZonePct: number;

  whaleUsdThreshold: number;
  volumeSpikeMultiplier: number;

  twitterKeywords: string[];

  weights: TokenWeights;

  buyThreshold: number;
  sellThreshold: number;

  positionSizePct: number;
  stopLossPct: number;
  takeProfitPct: number;
}

export interface RiskConfig {
  maxConcurrentPositions: number;
  maxPositionSizePct: number;
  dailyLossLimitPct: number;
}

export interface WatchlistConfig {
  tokens: TokenConfig[];
  twitterAccounts: string[];
  risk: RiskConfig;
}
