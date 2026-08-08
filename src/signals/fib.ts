import type { OhlcvCandle } from "../data/birdeye.js";

export interface Swing {
  highPrice: number;
  highTime: number;
  lowPrice: number;
  lowTime: number;
  /** "up" = rallied low->high, so retracement levels sit below price and act as support.
   *  "down" = dropped high->low, so retracement levels sit above price and act as resistance. */
  direction: "up" | "down";
}

export function findSwing(candles: OhlcvCandle[]): Swing {
  if (candles.length === 0) throw new Error("Cannot find swing on empty candle set");

  let highCandle = candles[0];
  let lowCandle = candles[0];
  for (const c of candles) {
    if (c.high > highCandle.high) highCandle = c;
    if (c.low < lowCandle.low) lowCandle = c;
  }

  return {
    highPrice: highCandle.high,
    highTime: highCandle.unixTime,
    lowPrice: lowCandle.low,
    lowTime: lowCandle.unixTime,
    direction: lowCandle.unixTime <= highCandle.unixTime ? "up" : "down",
  };
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

export interface Pivot {
  price: number;
  time: number;
  type: "high" | "low";
}

/** A candle counts as a pivot when it's the high/low extreme among its `window` neighbors on each side. */
export function findPivots(candles: OhlcvCandle[], window = 3): Pivot[] {
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

export function pctDistance(price: number, target: number): number {
  return (Math.abs(price - target) / target) * 100;
}

export function isWithinZone(price: number, target: number, zonePct: number): boolean {
  return pctDistance(price, target) <= zonePct;
}
