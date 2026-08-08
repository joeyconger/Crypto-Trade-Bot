import type { TokenConfig } from "../types/index.js";

export interface SocialSignalResult {
  score: number;
  detail: string;
}

/**
 * Social signal is disabled for v1 -- no Twitter/X integration is wired in
 * (see README for the cost/ToS tradeoff that led to this). Always returns a
 * neutral 0 so the combined scoring engine can sum all three signals
 * uniformly; set weights.social to 0 in config/watchlist.yaml so it doesn't
 * silently drag every combined score toward zero.
 */
export async function evaluateSocialSignal(_token: TokenConfig): Promise<SocialSignalResult> {
  return { score: 0, detail: "social signal disabled (no Twitter/X integration configured)" };
}
