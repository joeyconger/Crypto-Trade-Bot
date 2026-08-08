import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./connection.js";
import { getBotKeypair } from "./keypair.js";

export interface TokenBalance {
  amountRaw: string;
  decimals: number;
  uiAmount: number;
}

/**
 * Reads the bot wallet's actual on-chain balance for a mint via the RPC's
 * parsed-account view -- authoritative, unlike trusting a swap quote's
 * outAmount/decimals or a third-party API's decimals field.
 */
export async function getTokenBalanceRaw(mint: string): Promise<TokenBalance | undefined> {
  const connection = getConnection();
  const keypair = getBotKeypair();

  const resp = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, { mint: new PublicKey(mint) });
  const account = resp.value[0];
  if (!account) return undefined;

  const tokenAmount = account.account.data.parsed.info.tokenAmount;
  return {
    amountRaw: tokenAmount.amount,
    decimals: tokenAmount.decimals,
    uiAmount: tokenAmount.uiAmount ?? 0,
  };
}
