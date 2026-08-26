import { getTokenOverview } from "./priceProvider.js";

/**
 * The shortened-address placeholder used whenever a real ticker isn't
 * available. Exported separately (not just inlined in resolveTokenSymbol)
 * so a caller that already has a TokenOverview in hand -- fetched for some
 * other reason -- can build the same fallback label without triggering a
 * second, redundant lookup of the same token. dashboardRoutes.ts's
 * UNRESOLVED_SYMBOL_PATTERN matches this exact shape to find rows worth
 * re-resolving later.
 */
export function shortenedTokenLabel(tokenAddress: string): string {
  return `${tokenAddress.slice(0, 4)}…${tokenAddress.slice(-4)}`;
}

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
  return shortenedTokenLabel(tokenAddress);
}
