import type { OhlcvCandle } from "../data/birdeye.js";

export interface Swing {
  highPrice: number;
  highTime: number;
  lowPrice: number;
  lowTime: number;
  /** "up" = rallied low->high (bullish structure -- retracement levels sit below price and act as support).
   *  "down" = dropped high->low (bearish structure -- retracement levels sit above price and act as resistance). */
  direction: "up" | "down";
}

export interface FibLevel {
  level: number;
  price: number;
}

export function computeFibLevels(swing: Swing, levels: number[]): FibLevel[] {
  const range = swing.highPrice - swing.lowPrice;
  return levels.map((level) => ({
    level,
    price: swing.direction === "up" ? swing.highPrice - range * level : swing.lowPrice + range * level,
  }));
}

/** Extension levels (ratio > 1) projected beyond the impulse leg -- e.g. 1.272/1.618 take-profit targets. */
export function computeFibExtensions(swing: Swing, ratios: number[]): FibLevel[] {
  const range = swing.highPrice - swing.lowPrice;
  return ratios.map((level) => ({
    level,
    price: swing.direction === "up" ? swing.lowPrice + range * level : swing.highPrice - range * level,
  }));
}

export interface Pivot {
  price: number;
  time: number;
  type: "high" | "low";
}

/** A candle counts as a pivot when it's the high/low extreme among its `window` neighbors on each side (a fractal). */
export function findPivots(candles: OhlcvCandle[], window = 5): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = window; i < candles.length - window; i++) {
    const slice = candles.slice(i - window, i + window + 1);
    const c = candles[i];
    if (c.high === Math.max(...slice.map((s) => s.high))) {
      pivots.push({ price: c.high, time: c.unixTime, type: "high" });
    }
    if (c.low === Math.min(...slice.map((s) => s.low))) {
      pivots.push({ price: c.low, time: c.unixTime, type: "low" });
    }
  }
  return pivots;
}

/**
 * The most recent CONFIRMED swing -- the most recent confirmed pivot high,
 * paired with the swing low the rally leading to it started from (the most
 * recent confirmed low BEFORE that high). Each pivot needs `pivotWindow`
 * candles on both sides before counting as a real local extreme, not
 * still-forming price action. Undefined until there's enough history to
 * confirm at least one pivot high and one pivot low at all.
 *
 * A pivot low confirmed AFTER the high (e.g. a minor bounce during the
 * pullback) does NOT by itself flip this to a "down" swing -- that's what a
 * golden-pocket retracement in a live uptrend looks like, and treating every
 * such wiggle as a structure break made this essentially never confirm an
 * "up" swing on real, noisy price action. It only counts as broken structure
 * -- genuinely bearish, not a retracement -- if that post-high low actually
 * traded BELOW the level the rally started from.
 */
export function findConfirmedSwing(candles: OhlcvCandle[], pivotWindow = 5): Swing | undefined {
  const pivots = findPivots(candles, pivotWindow);
  const highs = pivots.filter((p) => p.type === "high").sort((a, b) => b.time - a.time);
  const lows = pivots.filter((p) => p.type === "low").sort((a, b) => b.time - a.time);

  const mostRecentHigh = highs[0];
  const mostRecentLow = lows[0];
  if (!mostRecentHigh || !mostRecentLow) return undefined;

  const lowBeforeHigh = lows.find((p) => p.time < mostRecentHigh.time);
  const structureBroken =
    lowBeforeHigh !== undefined && mostRecentLow.time > mostRecentHigh.time && mostRecentLow.price < lowBeforeHigh.price;

  if (lowBeforeHigh && !structureBroken) {
    return {
      highPrice: mostRecentHigh.price,
      highTime: mostRecentHigh.time,
      lowPrice: lowBeforeHigh.price,
      lowTime: lowBeforeHigh.time,
      direction: "up",
    };
  }

  // No low precedes the most recent high at all (pure decline so far, no
  // rally to retrace yet), or the pullback broke below the rally's origin --
  // either way, the most recently confirmed structure is bearish.
  return {
    highPrice: mostRecentHigh.price,
    highTime: mostRecentHigh.time,
    lowPrice: mostRecentLow.price,
    lowTime: mostRecentLow.time,
    direction: "down",
  };
}

export function pctDistance(price: number, target: number): number {
  return (Math.abs(price - target) / target) * 100;
}

export function isWithinZone(price: number, target: number, zonePct: number): boolean {
  return pctDistance(price, target) <= zonePct;
}

export interface GoldenPocketCheck {
  passed: boolean;
  swing?: Swing;
  matchedLevel?: FibLevel;
  reason: string;
}

/**
 * The fib filter: only ever evaluated after the on-chain trigger fires, and
 * never triggers a trade by itself. Requires a confirmed "up" swing (buying
 * a dip in a structure that's actually been rallying -- this is a long-only
 * bot, so a confirmed "down" swing means don't chase, not "buy the bounce"),
 * with current price within `zonePct` of the 0.5 or 0.618 retracement.
 */
export function checkGoldenPocket(
  candles: OhlcvCandle[],
  currentPrice: number,
  pivotWindow: number,
  zonePct: number,
): GoldenPocketCheck {
  const swing = findConfirmedSwing(candles, pivotWindow);
  if (!swing) {
    return { passed: false, reason: "no confirmed swing yet (not enough pivot-confirming price history)" };
  }
  if (swing.direction !== "up") {
    return { passed: false, swing, reason: "most recent confirmed swing is bearish -- not chasing a downtrend bounce" };
  }

  const levels = computeFibLevels(swing, [0.5, 0.618]);
  const matchedLevel = levels.find((l) => isWithinZone(currentPrice, l.price, zonePct));

  if (!matchedLevel) {
    return { passed: false, swing, reason: `price ${currentPrice} not within ${zonePct}% of the 0.5/0.618 golden pocket` };
  }

  return { passed: true, swing, matchedLevel, reason: `price at fib ${matchedLevel.level} (${matchedLevel.price})` };
}
