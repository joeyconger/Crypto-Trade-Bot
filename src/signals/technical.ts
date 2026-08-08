import { getOhlcv, type OhlcvCandle, type OhlcvInterval } from "../data/birdeye.js";
import { computeFibLevels, findPivots, findSwing, isWithinZone, pctDistance, type FibLevel, type Swing } from "./fib.js";
import type { TokenConfig } from "../types/index.js";

export interface TechnicalSignalResult {
  score: number; // [-1, 1]
  currentPrice: number;
  candles: OhlcvCandle[];
  swing: Swing;
  fibLevels: FibLevel[];
  matchedLevel?: FibLevel;
  bounceConfirmed: boolean;
  hasConfluence: boolean;
  detail: string;
}

// Interval scales with the configured lookback so a token watched over a few hours
// gets fine-grained candles, while a multi-week lookback doesn't over-fetch.
function pickInterval(lookbackHours: number): OhlcvInterval {
  if (lookbackHours <= 12) return "5m";
  if (lookbackHours <= 48) return "15m";
  if (lookbackHours <= 24 * 14) return "1H";
  return "4H";
}

function emptyResult(candles: OhlcvCandle[], reason: string): TechnicalSignalResult {
  return {
    score: 0,
    currentPrice: candles.at(-1)?.close ?? 0,
    candles,
    swing: { highPrice: 0, highTime: 0, lowPrice: 0, lowTime: 0, direction: "up" },
    fibLevels: [],
    bounceConfirmed: false,
    hasConfluence: false,
    detail: reason,
  };
}

export async function evaluateTechnicalSignal(token: TokenConfig): Promise<TechnicalSignalResult> {
  const interval = pickInterval(token.swingLookbackHours);
  const timeTo = Math.floor(Date.now() / 1000);
  const timeFrom = timeTo - token.swingLookbackHours * 3600;

  const candles = (await getOhlcv(token.address, interval, timeFrom, timeTo)).sort(
    (a, b) => a.unixTime - b.unixTime,
  );

  if (candles.length < 10) {
    return emptyResult(candles, `Not enough OHLCV data (${candles.length} candles) to evaluate`);
  }

  const swing = findSwing(candles);
  const fibLevels = computeFibLevels(swing, token.fibLevels);
  const pivots = findPivots(candles);

  const last = candles.at(-1)!;
  const prev = candles.at(-2)!;
  const currentPrice = last.close;

  // Closest fib level to current price, if any is within the confluence zone.
  let matchedLevel: FibLevel | undefined;
  let minDist = Infinity;
  for (const lvl of fibLevels) {
    if (isWithinZone(currentPrice, lvl.price, token.confluenceZonePct)) {
      const dist = Math.abs(currentPrice - lvl.price);
      if (dist < minDist) {
        minDist = dist;
        matchedLevel = lvl;
      }
    }
  }

  if (!matchedLevel) {
    return {
      ...emptyResult(candles, `Price ${currentPrice} not within ${token.confluenceZonePct}% of any fib level`),
      swing,
      fibLevels,
    };
  }

  const directionSign = swing.direction === "up" ? 1 : -1;
  const distPct = pctDistance(currentPrice, matchedLevel.price);
  const proximity = Math.max(0, 1 - distPct / token.confluenceZonePct);

  // Bounce confirmed: the prior candle traded into the zone and the latest candle
  // closed back away from it in the direction the swing implies.
  const zoneEdge = token.confluenceZonePct / 100;
  const bounceConfirmed =
    swing.direction === "up"
      ? prev.low <= matchedLevel.price * (1 + zoneEdge) && last.close > prev.close
      : prev.high >= matchedLevel.price * (1 - zoneEdge) && last.close < prev.close;

  const hasConfluence = pivots.some((p) => isWithinZone(matchedLevel!.price, p.price, token.confluenceZonePct));

  const rawScore = directionSign * proximity * (bounceConfirmed ? 1 : 0.5) * (hasConfluence ? 1.3 : 1);
  const score = Math.max(-1, Math.min(1, rawScore));

  return {
    score,
    currentPrice,
    candles,
    swing,
    fibLevels,
    matchedLevel,
    bounceConfirmed,
    hasConfluence,
    detail: `Price ${currentPrice} at fib ${matchedLevel.level} (${matchedLevel.price.toFixed(6)}), ${swing.direction}trend, bounce=${bounceConfirmed}, confluence=${hasConfluence}`,
  };
}
