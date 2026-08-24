import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./connection.js";
import { getBotKeypair } from "./keypair.js";

export interface TokenBalance {
  amountRaw: string;
  decimals: number;
  uiAmount: number;
}

// The two SPL token programs' well-known, network-wide addresses -- not
// worth pulling in the @solana/spl-token package (not otherwise a
// dependency here) just for these two constants. getAllTokenBalances scans
// BOTH: a getParsedTokenAccountsByOwner call filtered by `programId` only
// returns accounts owned by that exact program, unlike a `mint`-filtered
// call (see getTokenBalanceRaw below), which resolves the owning program
// from the mint itself -- so enumerating "everything held" with no mint
// known ahead of time needs one pass per program or it silently misses any
// Token-2022-based holding (increasingly used for transfer-fee/extension
// features on newer launches).
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

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

  const responses = await Promise.all(
    [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
      connection.getParsedTokenAccountsByOwner(keypair.publicKey, { programId }),
    ),
  );
  return responses
    .flatMap((resp) => resp.value)
    .map((account) => {
      const info = account.account.data.parsed.info;
      return { mint: info.mint as string, uiAmount: (info.tokenAmount.uiAmount as number | null) ?? 0 };
    })
    .filter((t) => t.uiAmount > 0);
}

/**
 * Reads the bot wallet's actual on-chain balance for a mint via the RPC's
 * parsed-account view -- authoritative, unlike trusting a swap quote's
 * outAmount/decimals or a third-party API's decimals field. Filtering by
 * `mint` (rather than `programId`, as getAllTokenBalances must) resolves
 * the owning token program from the mint itself, so this already works for
 * both the legacy SPL Token program and Token-2022 with no changes needed.
 *
 * Sums across every matching account rather than trusting resp.value[0] --
 * a wallet can in principle hold more than one token account for the same
 * mint (e.g. a stray non-ATA account from some external interaction); this
 * bot's own flow always uses the canonical ATA, but getAllTokenBalances
 * (used for portfolio valuation) already sums across all accounts, so this
 * matches that rather than silently under-reporting/under-selling if a
 * second account ever exists.
 */
export async function getTokenBalanceRaw(mint: string): Promise<TokenBalance | undefined> {
  const connection = getConnection();
  const keypair = getBotKeypair();

  const resp = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, { mint: new PublicKey(mint) });
  if (resp.value.length === 0) return undefined;

  const decimals = resp.value[0].account.data.parsed.info.tokenAmount.decimals;
  const amountRaw = resp.value.reduce((sum, account) => sum + BigInt(account.account.data.parsed.info.tokenAmount.amount), 0n);
  const uiAmount = resp.value.reduce((sum, account) => sum + (account.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);

  return { amountRaw: amountRaw.toString(), decimals, uiAmount };
}
