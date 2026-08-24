import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./connection.js";
import { getBotKeypair } from "./keypair.js";

export interface TokenBalance {
  amountRaw: string;
  decimals: number;
  uiAmount: number;
}

// The SPL Token program's well-known, network-wide address -- not worth
// pulling in the @solana/spl-token package (not otherwise a dependency here)
// just for this one constant.
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export interface HeldToken {
  mint: string;
  uiAmount: number;
}

/**
 * Every SPL token the bot wallet currently holds a nonzero balance of --
 * used to value the wallet's full portfolio (SOL + open positions), not
 * just its liquid SOL. Zero-balance accounts (e.g. left behind after a full
 * sell, before/if the account is ever closed) are filtered out since they
 * don't represent real holdings.
 */
export async function getAllTokenBalances(): Promise<HeldToken[]> {
  const connection = getConnection();
  const keypair = getBotKeypair();

  const resp = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, { programId: TOKEN_PROGRAM_ID });
  return resp.value
    .map((account) => {
      const info = account.account.data.parsed.info;
      return { mint: info.mint as string, uiAmount: (info.tokenAmount.uiAmount as number | null) ?? 0 };
    })
    .filter((t) => t.uiAmount > 0);
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
