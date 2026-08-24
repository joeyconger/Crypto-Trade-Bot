import type { HeliusTransaction } from "../data/helius.js";

/**
 * Parses Helius's "enhanced transaction" shape for a SWAP event, from the
 * perspective of one specific wallet. This is the same object shape as
 * data/helius.ts's polling endpoint returns (Helius documents webhook
 * deliveries as the identical enhanced-transaction format, just pushed
 * instead of pulled) -- but that's UNVERIFIED from this sandbox (no live
 * network access here), same caveat as every other Helius/GeckoTerminal/
 * Birdeye integration in this codebase. If real webhook payloads turn out
 * to have a different shape, parsing below fails per-field defensively and
 * gets logged as a parse_error rather than throwing or fabricating data --
 * check the raw payload on the first live delivery before assuming the
 * wallet-tail logic itself is wrong.
 */

const WSOL_MINT = "So11111111111111111111111111111111111111112";
// Best-known major Solana stablecoin mints -- used only to decide "treat
// this leg's price as $1 instead of fetching it," an approximation good
// enough for a quote leg (real depegs are rare and small) but not something
// this list should be trusted for beyond that.
const STABLECOIN_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export interface ParsedSwapLeg {
  netAmount: number; // positive = wallet received, negative = wallet sent
  mint: string;
}

export interface ParsedSwap {
  side: "buy" | "sell"; // from the tailed wallet's perspective
  tokenAddress: string;
  tokenAmount: number; // always positive
  quoteMint: string;
  quoteAmount: number; // always positive
  quoteIsStable: boolean;
  txSignature: string;
  onchainAt: string; // ISO
  // TEMPORARY diagnostic, only populated when the quote leg is WSOL -- see
  // the comment on netLegsForWallet. Remove once the ~-50% slippage bug is
  // confirmed/fixed.
  quoteLegBreakdown?: { tokenTransferAmount: number; nativeTransferAmount: number };
}

export type ParseResult = { ok: true; swap: ParsedSwap } | { ok: false; reason: string };

const DUST_THRESHOLD = 1e-9;

/**
 * TEMPORARY diagnostic (see quoteLegBreakdown on ParsedSwap below) -- being
 * investigated: entry_slippage_vs_wallet_pct has been landing at a suspiciously
 * uniform ~-50% across many trades regardless of the token's own liquidity/
 * market cap, which points at wallet_entry_price_usd being inflated ~2x
 * rather than real price impact. Prime suspect is right here: if a swap's
 * SOL leg shows up as BOTH a tokenTransfers entry (WSOL_MINT) AND a
 * nativeTransfers entry for the same underlying movement (e.g. the lamports
 * that funded/closed a temporary wrapped-SOL account during routing), the
 * two get summed into the same bucket below instead of being the same money
 * counted twice. This function now also returns each source's contribution
 * to the WSOL_MINT bucket separately so the next live trade can confirm (or
 * rule out) that theory before a real fix is written. Remove once resolved.
 */
interface NettedLegs {
  legs: ParsedSwapLeg[];
  wsolTokenTransferAmount: number;
  wsolNativeTransferAmount: number;
}

/** Nets every transfer touching `walletAddress` (token + native SOL) by mint, filtering out near-zero pass-through legs from multi-hop routing. */
function netLegsForWallet(tx: HeliusTransaction, walletAddress: string): NettedLegs {
  const netByMint = new Map<string, number>();

  for (const t of tx.tokenTransfers ?? []) {
    if (!t.mint || !Number.isFinite(t.tokenAmount)) continue;
    let delta = 0;
    if (t.toUserAccount === walletAddress) delta += t.tokenAmount;
    if (t.fromUserAccount === walletAddress) delta -= t.tokenAmount;
    if (delta === 0) continue;
    netByMint.set(t.mint, (netByMint.get(t.mint) ?? 0) + delta);
  }

  const wsolTokenTransferAmount = netByMint.get(WSOL_MINT) ?? 0;

  let nativeDelta = 0;
  for (const t of tx.nativeTransfers ?? []) {
    if (!Number.isFinite(t.amount)) continue;
    if (t.toUserAccount === walletAddress) nativeDelta += t.amount;
    if (t.fromUserAccount === walletAddress) nativeDelta -= t.amount;
  }
  const wsolNativeTransferAmount = nativeDelta / 1_000_000_000;
  if (nativeDelta !== 0) {
    netByMint.set(WSOL_MINT, (netByMint.get(WSOL_MINT) ?? 0) + wsolNativeTransferAmount);
  }

  return {
    legs: [...netByMint.entries()]
      .filter(([, amount]) => Math.abs(amount) > DUST_THRESHOLD)
      .map(([mint, netAmount]) => ({ mint, netAmount })),
    wsolTokenTransferAmount,
    wsolNativeTransferAmount,
  };
}

function isQuoteMint(mint: string): boolean {
  return mint === WSOL_MINT || STABLECOIN_MINTS.has(mint);
}

export function parseSwapForWallet(tx: HeliusTransaction, walletAddress: string): ParseResult {
  if (tx.type !== "SWAP") {
    return { ok: false, reason: `not a SWAP event (type=${tx.type})` };
  }

  const { legs, wsolTokenTransferAmount, wsolNativeTransferAmount } = netLegsForWallet(tx, walletAddress);
  const tokenLegs = legs.filter((l) => !isQuoteMint(l.mint));
  const quoteLegs = legs.filter((l) => isQuoteMint(l.mint));

  // Exactly one non-quote leg is required to know unambiguously which asset
  // is "the one being tailed" -- zero means nothing recognizable was traded
  // (or it's a pure SOL<->stablecoin swap, not a token trade), more than one
  // means a genuine multi-token swap with no single answer to mirror.
  if (tokenLegs.length !== 1) {
    return {
      ok: false,
      reason: `expected exactly 1 non-quote (traded-token) leg, found ${tokenLegs.length} -- ${JSON.stringify(legs)}`,
    };
  }
  if (quoteLegs.length === 0) {
    return { ok: false, reason: `no SOL/stablecoin leg found to price the trade against -- ${JSON.stringify(legs)}` };
  }

  const token = tokenLegs[0];
  if (token.netAmount === 0) {
    return { ok: false, reason: `traded-token leg netted to zero -- ${JSON.stringify(legs)}` };
  }

  // In practice a real swap's quote side is one asset, but the tailed
  // wallet's transaction can carry a SECOND, much smaller SOL movement
  // alongside it -- observed live: e.g. -5000 USDC / +318,533 TOKEN /
  // +0.027 SOL in the same tx. That extra SOL is almost certainly gas,
  // an ATA-rent refund from closing a temporary wrapped-SOL account, or a
  // routing/referral rebate -- not the trade itself -- so when a stablecoin
  // leg is present alongside a SOL leg, the stablecoin is treated as the
  // real quote and the SOL leg is dropped as noise. This is a live-data
  // fix, not a guess: every quote leg it was built to catch as ambiguous
  // before this turned out to be exactly this shape. If quote legs are
  // ever ambiguous in some other way (e.g. two distinct stablecoins, which
  // hasn't been observed), the larger-magnitude one wins as a fallback --
  // still a best-effort choice, not a verified rule.
  const quote =
    quoteLegs.length === 1
      ? quoteLegs[0]
      : quoteLegs.find((l) => STABLECOIN_MINTS.has(l.mint)) ??
        quoteLegs.reduce((biggest, l) => (Math.abs(l.netAmount) > Math.abs(biggest.netAmount) ? l : biggest));

  const side: "buy" | "sell" = token.netAmount > 0 ? "buy" : "sell";

  return {
    ok: true,
    swap: {
      side,
      tokenAddress: token.mint,
      tokenAmount: Math.abs(token.netAmount),
      quoteMint: quote.mint,
      quoteAmount: Math.abs(quote.netAmount),
      quoteIsStable: STABLECOIN_MINTS.has(quote.mint),
      txSignature: tx.signature,
      onchainAt: new Date(tx.timestamp * 1000).toISOString(),
      // TEMPORARY diagnostic -- only meaningful when the quote leg is WSOL
      // and both sources contributed (that's the suspected double-count).
      ...(quote.mint === WSOL_MINT && wsolTokenTransferAmount !== 0 && wsolNativeTransferAmount !== 0
        ? { quoteLegBreakdown: { tokenTransferAmount: wsolTokenTransferAmount, nativeTransferAmount: wsolNativeTransferAmount } }
        : {}),
    },
  };
}
