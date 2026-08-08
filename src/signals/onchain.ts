import { getTokenOverview, type OhlcvCandle } from "../data/birdeye.js";
import { detectWhaleMoves, type WhaleEvent } from "../onchain/whales.js";
import {
  getLastTxSignature,
  setLastTxSignature,
  getRecentOnchainSnapshots,
  insertOnchainSnapshot,
} from "../db/index.js";
import type { TokenConfig } from "../types/index.js";

export interface OnchainSignalResult {
  score: number; // [-1, 1]
  whaleEvents: WhaleEvent[];
  volumeSpike: { isSpike: boolean; currentVolume: number; rollingAvgVolume: number };
  liquidity: { changePct: number; currentLiquidityUsd: number; avgLiquidityUsd: number };
  detail: string;
}

function scoreWhaleEvents(events: WhaleEvent[], threshold: number): number {
  if (events.length === 0) return 0;
  const net = events.reduce((sum, e) => sum + (e.side === "buy" ? e.usdSize : -e.usdSize), 0);
  return Math.max(-1, Math.min(1, net / (threshold * 4)));
}

function scoreVolumeSpike(
  candles: OhlcvCandle[],
  multiplier: number,
): { isSpike: boolean; currentVolume: number; rollingAvgVolume: number; score: number } {
  if (candles.length < 6) return { isSpike: false, currentVolume: 0, rollingAvgVolume: 0, score: 0 };

  const last = candles.at(-1)!;
  const priorWindow = candles.slice(-6, -1);
  const rollingAvgVolume = priorWindow.reduce((s, c) => s + c.volume, 0) / priorWindow.length;
  const isSpike = rollingAvgVolume > 0 && last.volume >= rollingAvgVolume * multiplier;

  const direction = last.close >= last.open ? 1 : -1;
  const score = isSpike ? direction * Math.min(1, last.volume / (rollingAvgVolume * multiplier * 2)) : 0;

  return { isSpike, currentVolume: last.volume, rollingAvgVolume, score };
}

/**
 * Combines whale activity (Helius), volume spikes (from the same OHLCV candles
 * the technical signal already fetched), and liquidity change (our own rolling
 * history of Birdeye snapshots, since historical liquidity isn't available on
 * the free tier) into one on-chain score.
 */
export async function evaluateOnchainSignal(
  token: TokenConfig,
  recentCandles: OhlcvCandle[],
): Promise<OnchainSignalResult> {
  const overview = await getTokenOverview(token.address);

  const lastSignature = getLastTxSignature(token.address);
  const { events: whaleEvents, latestSignature } = await detectWhaleMoves(token, overview.price, lastSignature);
  if (latestSignature) setLastTxSignature(token.address, latestSignature);

  const volumeSpike = scoreVolumeSpike(recentCandles, token.volumeSpikeMultiplier);

  const snapshots = getRecentOnchainSnapshots(token.address, 10);
  const avgLiquidityUsd =
    snapshots.length > 0 ? snapshots.reduce((s, r) => s + r.liquidity_usd, 0) / snapshots.length : overview.liquidityUsd;
  const changePct = avgLiquidityUsd > 0 ? ((overview.liquidityUsd - avgLiquidityUsd) / avgLiquidityUsd) * 100 : 0;
  insertOnchainSnapshot(token.address, overview.liquidityUsd, overview.volume24hUsd);

  // A sharp liquidity drop (possible LP pull) is a strong risk flag; a rise is
  // only a mild confidence signal, weighted much less than an equivalent drop.
  const liquidityScore = changePct <= -15 ? -1 : changePct >= 30 ? 0.3 : 0;

  const whaleScore = scoreWhaleEvents(whaleEvents, token.whaleUsdThreshold);

  const score = Math.max(-1, Math.min(1, whaleScore * 0.5 + volumeSpike.score * 0.3 + liquidityScore * 0.2));

  return {
    score,
    whaleEvents,
    volumeSpike: {
      isSpike: volumeSpike.isSpike,
      currentVolume: volumeSpike.currentVolume,
      rollingAvgVolume: volumeSpike.rollingAvgVolume,
    },
    liquidity: { changePct, currentLiquidityUsd: overview.liquidityUsd, avgLiquidityUsd },
    detail: `whales=${whaleEvents.length} (score ${whaleScore.toFixed(2)}), volumeSpike=${volumeSpike.isSpike} (score ${volumeSpike.score.toFixed(2)}), liquidityChange=${changePct.toFixed(1)}%`,
  };
}
