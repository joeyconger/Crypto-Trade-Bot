import { getTokenOverview } from "../data/priceProvider.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type FillLookup = { ok: true; priceUsd: number; liquidityUsd: number } | { ok: false; error: string };

async function lookupPrice(tokenAddress: string): Promise<FillLookup> {
  try {
    const overview = await getTokenOverview(tokenAddress);
    if (!overview || !Number.isFinite(overview.price) || overview.price <= 0) {
      return { ok: false, error: "provider returned no usable price" };
    }
    return { ok: true, priceUsd: overview.price, liquidityUsd: overview.liquidityUsd };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The core of the simulation: waits `delaySeconds` in real wall-clock time
 * (representing route-building + tx submission + confirmation), THEN looks
 * up the token's price -- not the price at detection time, and not the
 * tailed wallet's actual fill price. Real time genuinely elapses before the
 * lookup, which is what makes this an honest simulation of being behind
 * rather than an instant/perfect fill.
 */
export async function simulateDelayedFill(tokenAddress: string, delaySeconds: number): Promise<FillLookup> {
  if (delaySeconds > 0) await sleep(delaySeconds * 1000);
  return lookupPrice(tokenAddress);
}

/**
 * USD price for whatever the tailed wallet paid/received with. Stablecoins
 * are treated as a flat $1 (a standard, cheap approximation -- real depegs
 * are rare and small); anything else (almost always SOL) gets a live price
 * lookup, since reconstructing a swap's USD-denominated fill price needs to
 * know what the quote leg was worth. This is fetched at CALL time (i.e.
 * near-immediately on webhook receipt), not at the tx's on-chain timestamp
 * -- there's no sub-minute historical price API available to this bot, so
 * "now" is the best available proxy for "a few seconds ago." Fine for SOL
 * over that short a gap; noted here so it isn't mistaken for an exact figure.
 */
export async function getQuoteUsdPrice(quoteMint: string, quoteIsStable: boolean): Promise<FillLookup> {
  if (quoteIsStable) return { ok: true, priceUsd: 1, liquidityUsd: Infinity };
  return lookupPrice(quoteMint);
}
