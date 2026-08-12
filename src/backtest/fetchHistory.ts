import { getOhlcv } from "../data/priceProvider.js";
import type { OhlcvCandle } from "../data/types.js";

const MAX_PAGES = 50; // bounded to avoid a runaway loop against a misbehaving provider

/**
 * Pages backward through history to assemble a candle series spanning
 * [fromUnix, toUnix] at the granularity the live bot would use for a token
 * with this swingLookbackHours (see pickTimeframe/pickOhlcvInterval in the
 * active provider). A single getOhlcv call is capped (e.g. 1000 candles on
 * GeckoTerminal), so a multi-month backtest range needs several calls --
 * this walks backward from toUnix, using each batch's oldest timestamp as
 * the next call's upper bound, until fromUnix is covered or the provider
 * stops returning new data.
 */
export async function fetchHistoricalCandles(
  address: string,
  swingLookbackHours: number,
  fromUnix: number,
  toUnix: number,
): Promise<OhlcvCandle[]> {
  const all = new Map<number, OhlcvCandle>();
  let cursor = toUnix;

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await getOhlcv(address, swingLookbackHours, fromUnix, cursor);
    if (batch.length === 0) break;

    let oldestInBatch = cursor;
    for (const candle of batch) {
      all.set(candle.unixTime, candle);
      if (candle.unixTime < oldestInBatch) oldestInBatch = candle.unixTime;
    }

    if (oldestInBatch <= fromUnix || oldestInBatch >= cursor) break; // covered the range, or no progress -- stop
    cursor = oldestInBatch - 1;
  }

  return [...all.values()].sort((a, b) => a.unixTime - b.unixTime);
}
