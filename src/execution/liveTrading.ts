import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getTokenOverview, getMultiPrice } from "../data/priceProvider.js";
import { getConnection } from "../solana/connection.js";
import { getBotKeypair } from "../solana/keypair.js";
import { getAllTokenBalances } from "../solana/tokenAccounts.js";
import { SOL_MINT } from "./jupiter.js";

export async function getBotSolBalance(): Promise<number> {
  const connection = getConnection();
  const keypair = getBotKeypair();
  const lamports = await connection.getBalance(keypair.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * The wallet's FULL portfolio value -- SOL plus every SPL token currently
 * held (e.g. an open tail position) -- not just liquid SOL. Used for live
 * position sizing and the daily loss cap, both of which need the real
 * account value: sizing a % of SOL-only would under/overweight a trade
 * depending on how much is tied up in open positions, and the loss cap
 * would miss a position crashing in value if SOL itself hadn't moved.
 * A token whose price can't be looked up (getMultiPrice omits it rather
 * than erroring) is valued at $0 here rather than failing the whole
 * balance read -- best-effort, same as every other price-provider call in
 * this codebase.
 */
export async function getBotWalletBalanceUsd(): Promise<number> {
  const [solBalance, solOverview, heldTokens] = await Promise.all([
    getBotSolBalance(),
    getTokenOverview(SOL_MINT),
    getAllTokenBalances(),
  ]);

  let total = solBalance * solOverview.price;
  if (heldTokens.length > 0) {
    const prices = await getMultiPrice(heldTokens.map((t) => t.mint));
    for (const t of heldTokens) {
      total += t.uiAmount * (prices.get(t.mint) ?? 0);
    }
  }
  return total;
}
