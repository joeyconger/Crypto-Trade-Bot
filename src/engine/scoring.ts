import { evaluateTechnicalSignal, type TechnicalSignalResult } from "../signals/technical.js";
import { evaluateOnchainSignal, type OnchainSignalResult } from "../signals/onchain.js";
import { evaluateSocialSignal, type SocialSignalResult } from "../signals/social.js";
import { insertSignalLog } from "../db/index.js";
import type { TokenConfig } from "../types/index.js";

export type SignalAction = "buy" | "sell" | "none";

export interface CombinedSignalResult {
  token: TokenConfig;
  technical: TechnicalSignalResult;
  onchain: OnchainSignalResult;
  social: SocialSignalResult;
  combinedScore: number;
  action: SignalAction;
}

function decideAction(score: number, token: TokenConfig): SignalAction {
  if (score >= token.buyThreshold) return "buy";
  if (score <= token.sellThreshold) return "sell";
  return "none";
}

/**
 * Runs all three signals for a token and weights them into one score using
 * the token's own weights (config/watchlist.yaml) -- NOT touching the DB.
 * Call logSignalEvaluation separately once the caller knows whether a trade
 * actually got taken (so trade_id can be attached to the same row).
 */
export async function evaluateToken(token: TokenConfig): Promise<CombinedSignalResult> {
  const technical = await evaluateTechnicalSignal(token);
  const onchain = await evaluateOnchainSignal(token, technical.candles);
  const social = await evaluateSocialSignal(token);

  const combinedScore =
    technical.score * token.weights.technical +
    onchain.score * token.weights.onchain +
    social.score * token.weights.social;

  return {
    token,
    technical,
    onchain,
    social,
    combinedScore,
    action: decideAction(combinedScore, token),
  };
}

/**
 * Persists the evaluation to signal_log -- including the "none" outcomes --
 * so every cycle is auditable, per the logging & visibility requirement.
 * Candle arrays are intentionally excluded from the stored detail (they're
 * large and reconstructable from Birdeye); only the interpreted summary is kept.
 */
export function logSignalEvaluation(result: CombinedSignalResult, tradeId?: number): number {
  const { token, technical, onchain, social, combinedScore, action } = result;

  return insertSignalLog({
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    technicalScore: technical.score,
    onchainScore: onchain.score,
    socialScore: social.score,
    combinedScore,
    technicalDetail: JSON.stringify({
      currentPrice: technical.currentPrice,
      swingDirection: technical.swing.direction,
      swingHigh: technical.swing.highPrice,
      swingLow: technical.swing.lowPrice,
      matchedLevel: technical.matchedLevel,
      bounceConfirmed: technical.bounceConfirmed,
      hasConfluence: technical.hasConfluence,
      detail: technical.detail,
    }),
    onchainDetail: JSON.stringify({
      whaleEvents: onchain.whaleEvents,
      volumeSpike: onchain.volumeSpike,
      liquidity: onchain.liquidity,
      detail: onchain.detail,
    }),
    socialDetail: JSON.stringify({ score: social.score, detail: social.detail }),
    actionTaken: action,
    tradeId,
  });
}
