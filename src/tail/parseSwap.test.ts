import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSwapForWallet } from "./parseSwap.js";
import type { HeliusTransaction } from "../data/helius.js";

const WALLET = "WalletAddress11111111111111111111111111111";
const TOKEN_MINT = "TokenMint1111111111111111111111111111111111";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function baseTx(overrides: Partial<HeliusTransaction> = {}): HeliusTransaction {
  return {
    signature: "sig1",
    timestamp: 1_700_000_000,
    type: "SWAP",
    feePayer: WALLET,
    tokenTransfers: [],
    nativeTransfers: [],
    ...overrides,
  };
}

test("parseSwapForWallet: buy paid with native SOL", () => {
  const tx = baseTx({
    tokenTransfers: [{ mint: TOKEN_MINT, tokenAmount: 1000, fromUserAccount: "poolX", toUserAccount: WALLET }],
    nativeTransfers: [{ amount: 2_000_000_000, fromUserAccount: WALLET, toUserAccount: "poolX" }], // 2 SOL
  });

  const result = parseSwapForWallet(tx, WALLET);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.swap.side, "buy");
  assert.equal(result.swap.tokenAddress, TOKEN_MINT);
  assert.equal(result.swap.tokenAmount, 1000);
  assert.equal(result.swap.quoteMint, WSOL_MINT);
  assert.equal(result.swap.quoteAmount, 2);
  assert.equal(result.swap.quoteIsStable, false);
});

test("parseSwapForWallet: sell for native SOL", () => {
  const tx = baseTx({
    tokenTransfers: [{ mint: TOKEN_MINT, tokenAmount: 500, fromUserAccount: WALLET, toUserAccount: "poolX" }],
    nativeTransfers: [{ amount: 1_000_000_000, fromUserAccount: "poolX", toUserAccount: WALLET }], // 1 SOL
  });

  const result = parseSwapForWallet(tx, WALLET);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.swap.side, "sell");
  assert.equal(result.swap.tokenAmount, 500);
  assert.equal(result.swap.quoteAmount, 1);
});

test("parseSwapForWallet: buy paid with USDC is flagged as a stable quote", () => {
  const tx = baseTx({
    tokenTransfers: [
      { mint: TOKEN_MINT, tokenAmount: 250, fromUserAccount: "poolX", toUserAccount: WALLET },
      { mint: USDC_MINT, tokenAmount: 50, fromUserAccount: WALLET, toUserAccount: "poolX" },
    ],
  });

  const result = parseSwapForWallet(tx, WALLET);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.swap.side, "buy");
  assert.equal(result.swap.quoteMint, USDC_MINT);
  assert.equal(result.swap.quoteIsStable, true);
});

test("parseSwapForWallet: rejects non-SWAP events", () => {
  const tx = baseTx({ type: "TRANSFER" });
  const result = parseSwapForWallet(tx, WALLET);
  assert.equal(result.ok, false);
});

test("parseSwapForWallet: pass-through legs that net to zero are ignored", () => {
  const tx = baseTx({
    tokenTransfers: [
      // routed through an intermediate mint the wallet briefly touches -- nets to zero
      { mint: "IntermediateMint1111111111111111111111111", tokenAmount: 10, fromUserAccount: "poolA", toUserAccount: WALLET },
      { mint: "IntermediateMint1111111111111111111111111", tokenAmount: 10, fromUserAccount: WALLET, toUserAccount: "poolB" },
      { mint: TOKEN_MINT, tokenAmount: 100, fromUserAccount: "poolB", toUserAccount: WALLET },
    ],
    nativeTransfers: [{ amount: 500_000_000, fromUserAccount: WALLET, toUserAccount: "poolA" }],
  });

  const result = parseSwapForWallet(tx, WALLET);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.swap.tokenAddress, TOKEN_MINT);
  assert.equal(result.swap.quoteMint, WSOL_MINT);
});

test("parseSwapForWallet: ambiguous when both legs are quote-like", () => {
  const tx = baseTx({
    tokenTransfers: [{ mint: USDC_MINT, tokenAmount: 100, fromUserAccount: "poolX", toUserAccount: WALLET }],
    nativeTransfers: [{ amount: 500_000_000, fromUserAccount: WALLET, toUserAccount: "poolX" }],
  });

  const result = parseSwapForWallet(tx, WALLET);
  assert.equal(result.ok, false);
});

test("parseSwapForWallet: more than one traded-token leg is unparseable", () => {
  const tx = baseTx({
    tokenTransfers: [
      { mint: TOKEN_MINT, tokenAmount: 100, fromUserAccount: "poolX", toUserAccount: WALLET },
      { mint: "OtherMint111111111111111111111111111111111", tokenAmount: 50, fromUserAccount: "poolY", toUserAccount: WALLET },
    ],
    nativeTransfers: [{ amount: 500_000_000, fromUserAccount: WALLET, toUserAccount: "poolX" }],
  });

  const result = parseSwapForWallet(tx, WALLET);
  assert.equal(result.ok, false);
});

test("parseSwapForWallet: a small residual SOL leg alongside a USDC-denominated buy is ignored, not fatal (real observed shape)", () => {
  // Live example: omo paid 5000 USDC, received 318,533 TOKEN, and also
  // received a small unrelated 0.027 SOL in the same tx (gas/rebate/rent
  // refund, not the trade) -- this used to be rejected as "3 legs found."
  const tx = baseTx({
    tokenTransfers: [
      { mint: USDC_MINT, tokenAmount: 5000, fromUserAccount: WALLET, toUserAccount: "poolX" },
      { mint: TOKEN_MINT, tokenAmount: 318533.13, fromUserAccount: "poolX", toUserAccount: WALLET },
    ],
    nativeTransfers: [{ amount: 27_000_000, fromUserAccount: "poolX", toUserAccount: WALLET }], // ~0.027 SOL
  });

  const result = parseSwapForWallet(tx, WALLET);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.swap.side, "buy");
  assert.equal(result.swap.tokenAddress, TOKEN_MINT);
  assert.equal(result.swap.tokenAmount, 318533.13);
  assert.equal(result.swap.quoteMint, USDC_MINT);
  assert.equal(result.swap.quoteAmount, 5000);
  assert.equal(result.swap.quoteIsStable, true);
});
