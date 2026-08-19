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
}

export type ParseResult = { ok: true; swap: ParsedSwap } | { ok: false; reason: string };

const DUST_THRESHOLD = 1e-9;

/** Nets every transfer touching `walletAddress` (token + native SOL) by mint, filtering out near-zero pass-through legs from multi-hop routing. */
function netLegsForWallet(tx: HeliusTransaction, walletAddress: string): ParsedSwapLeg[] {
  const netByMint = new Map<string, number>();

  for (const t of tx.tokenTransfers ?? []) {
    if (!t.mint || !Number.isFinite(t.tokenAmount)) continue;
    let delta = 0;
    if (t.toUserAccount === walletAddress) delta += t.tokenAmount;
    if (t.fromUserAccount === walletAddress) delta -= t.tokenAmount;
    if (delta === 0) continue;
    netByMint.set(t.mint, (netByMint.get(t.mint) ?? 0) + delta);
  }

  let nativeDelta = 0;
  for (const t of tx.nativeTransfers ?? []) {
    if (!Number.isFinite(t.amount)) continue;
    if (t.toUserAccount === walletAddress) nativeDelta += t.amount;
    if (t.fromUserAccount === walletAddress) nativeDelta -= t.amount;
  }
  if (nativeDelta !== 0) {
    const lamportsToSol = nativeDelta / 1_000_000_000;
    netByMint.set(WSOL_MINT, (netByMint.get(WSOL_MINT) ?? 0) + lamportsToSol);
  }

  return [...netByMint.entries()]
    .filter(([, amount]) => Math.abs(amount) > DUST_THRESHOLD)
    .map(([mint, netAmount]) => ({ mint, netAmount }));
}

export function parseSwapForWallet(tx: HeliusTransaction, walletAddress: string): ParseResult {
  if (tx.type !== "SWAP") {
    return { ok: false, reason: `not a SWAP event (type=${tx.type})` };
  }

  const legs = netLegsForWallet(tx, walletAddress);
  if (legs.length !== 2) {
    return {
      ok: false,
      reason: `expected exactly 2 net-nonzero legs for this wallet, found ${legs.length} -- ${JSON.stringify(legs)}`,
    };
  }

  const [a, b] = legs;
  const received = a.netAmount > 0 ? a : b;
  const sent = a.netAmount > 0 ? b : a;
  if (received.netAmount <= 0 || sent.netAmount >= 0) {
    return { ok: false, reason: `couldn't identify a clean received/sent pair -- ${JSON.stringify(legs)}` };
  }

  const receivedIsQuote = received.mint === WSOL_MINT || STABLECOIN_MINTS.has(received.mint);
  const sentIsQuote = sent.mint === WSOL_MINT || STABLECOIN_MINTS.has(sent.mint);

  // The traded token is whichever leg ISN'T SOL/a stablecoin -- if both legs
  // are quote-like (e.g. swapping USDC for SOL) or neither is (an exotic
  // token-for-token swap), there's no unambiguous "asset being tailed" to
  // mirror, so this is reported unparseable rather than guessed.
  let tokenAddress: string;
  let tokenAmount: number;
  let side: "buy" | "sell";
  let quoteMint: string;
  let quoteAmount: number;

  if (receivedIsQuote === sentIsQuote) {
    return {
      ok: false,
      reason: `ambiguous which leg is the traded token vs. the quote asset -- received ${received.mint}, sent ${Math.abs(sent.netAmount)} ${sent.mint}`,
    };
  } else if (sentIsQuote) {
    // paid with SOL/a stable, received the token -> buy
    side = "buy";
    tokenAddress = received.mint;
    tokenAmount = received.netAmount;
    quoteMint = sent.mint;
    quoteAmount = Math.abs(sent.netAmount);
  } else {
    // sent the token, received SOL/a stable -> sell
    side = "sell";
    tokenAddress = sent.mint;
    tokenAmount = Math.abs(sent.netAmount);
    quoteMint = received.mint;
    quoteAmount = received.netAmount;
  }

  return {
    ok: true,
    swap: {
      side,
      tokenAddress,
      tokenAmount,
      quoteMint,
      quoteAmount,
      quoteIsStable: STABLECOIN_MINTS.has(quoteMint),
      txSignature: tx.signature,
      onchainAt: new Date(tx.timestamp * 1000).toISOString(),
    },
  };
}
