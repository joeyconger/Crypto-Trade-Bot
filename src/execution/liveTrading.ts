import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getTokenOverview } from "../data/priceProvider.js";
import { getConnection } from "../solana/connection.js";
import { getBotKeypair } from "../solana/keypair.js";
import { SOL_MINT } from "./jupiter.js";

export async function getBotSolBalance(): Promise<number> {
  const connection = getConnection();
  const keypair = getBotKeypair();
  const lamports = await connection.getBalance(keypair.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

export async function getBotWalletBalanceUsd(): Promise<number> {
  const [solBalance, solOverview] = await Promise.all([getBotSolBalance(), getTokenOverview(SOL_MINT)]);
  return solBalance * solOverview.price;
}
