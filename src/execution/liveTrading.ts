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

export interface BotWalletSnapshot {
  solBalance: number; // liquid SOL only, in SOL (not lamports)
  solPriceUsd: number;
  totalBalanceUsd: number; // SOL + every held SPL token, priced -- see getBotWalletSnapshot's docstring
}

/**
 * One consistent read of the wallet's liquid SOL, current SOL price, and
 * FULL portfolio value (SOL + every SPL token currently held, e.g. an open
 * tail position) -- not just liquid SOL. A live buy needs all three
 * (sizing and the daily loss cap need totalBalanceUsd; converting that
 * $ size into an actual swap amount needs solBalance/solPriceUsd), and
 * fetching them as one snapshot -- instead of three independent calls at
 * three different moments, as an earlier version of the live-buy path did
 * -- avoids tripling price-provider load per trade (a real problem given
 * GeckoTerminal's rate limits) and keeps the SOL price used for sizing from
 * drifting from the price used moments later to size the swap itself.
 * A token whose price can't be looked up (getMultiPrice omits it rather
 * than erroring) is valued at $0 here rather than failing the whole
 * balance read -- best-effort, same as every other price-provider call in
 * this codebase.
 */
export async function getBotWalletSnapshot(): Promise<BotWalletSnapshot> {
  const [solBalance, solOverview, heldTokens] = await Promise.all([
    getBotSolBalance(),
    getTokenOverview(SOL_MINT),
    getAllTokenBalances(),
  ]);

  let totalBalanceUsd = solBalance * solOverview.price;
  if (heldTokens.length > 0) {
    const prices = await getMultiPrice(heldTokens.map((t) => t.mint));
    for (const t of heldTokens) {
      totalBalanceUsd += t.uiAmount * (prices.get(t.mint) ?? 0);
    }
  }
  return { solBalance, solPriceUsd: solOverview.price, totalBalanceUsd };
}

/** Convenience wrapper around getBotWalletSnapshot for callers that only need the USD total (e.g. the dashboard's balance display) -- not for the live-buy path, which needs the other snapshot fields too and should call getBotWalletSnapshot directly to avoid a second fetch. */
export async function getBotWalletBalanceUsd(): Promise<number> {
  return (await getBotWalletSnapshot()).totalBalanceUsd;
}
