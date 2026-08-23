import { getTokenOverview } from "./priceProvider.js";

/**
 * Best-effort real ticker via the active price provider (same call already
 * used for pricing elsewhere -- see TokenOverview's symbol field), falling
 * back to a shortened address if the provider errors or has no symbol for
 * this token. Shared by src/tail/mirror.ts and src/wallet-cluster/ so both
 * get the same "never block on a missing display label" behavior from one
 * place.
 */
export async function resolveTokenSymbol(tokenAddress: string): Promise<string> {
  try {
    const overview = await getTokenOverview(tokenAddress);
    if (overview.symbol) return overview.symbol;
  } catch {
    // fall through
  }
  return `${tokenAddress.slice(0, 4)}…${tokenAddress.slice(-4)}`;
}
