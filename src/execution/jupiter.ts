import { VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getConnection } from "../solana/connection.js";
import { getBotKeypair } from "../solana/keypair.js";

// Jupiter's free "lite" tier -- no API key, rate-limited. Fine for a single bot.
const JUP_BASE = "https://lite-api.jup.ag/swap/v1";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface JupiterSwapResult {
  signature: string;
  inAmount: string;
  outAmount: string;
}

async function getQuote(inputMint: string, outputMint: string, amountRaw: string, slippageBps: number): Promise<any> {
  const url = new URL(`${JUP_BASE}/quote`);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amountRaw);
  url.searchParams.set("slippageBps", String(slippageBps));

  const res = await fetch(url);
  const body: any = await res.json().catch(() => undefined);
  if (!res.ok) throw new Error(`Jupiter quote failed (${res.status}): ${JSON.stringify(body)}`);
  return body;
}

async function buildAndSendSwap(quoteResponse: any): Promise<{ signature: string }> {
  const keypair = getBotKeypair();

  const res = await fetch(`${JUP_BASE}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });

  const body: any = await res.json().catch(() => undefined);
  if (!res.ok || !body?.swapTransaction) {
    throw new Error(`Jupiter swap build failed (${res.status}): ${JSON.stringify(body)}`);
  }

  const connection = getConnection();
  const tx = VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, "base64"));
  tx.sign([keypair]);

  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });

  const latestBlockhash = await connection.getLatestBlockhash();
  const confirmation = await connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");
  if (confirmation.value.err) {
    throw new Error(`Swap ${signature} failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }

  return { signature };
}

export async function swapSolForToken(tokenMint: string, solAmount: number, slippageBps = 100): Promise<JupiterSwapResult> {
  const amountLamports = Math.floor(solAmount * LAMPORTS_PER_SOL).toString();
  const quote = await getQuote(SOL_MINT, tokenMint, amountLamports, slippageBps);
  const { signature } = await buildAndSendSwap(quote);
  return { signature, inAmount: quote.inAmount, outAmount: quote.outAmount };
}

export async function swapTokenForSol(tokenMint: string, tokenAmountRaw: string, slippageBps = 100): Promise<JupiterSwapResult> {
  const quote = await getQuote(tokenMint, SOL_MINT, tokenAmountRaw, slippageBps);
  const { signature } = await buildAndSendSwap(quote);
  return { signature, inAmount: quote.inAmount, outAmount: quote.outAmount };
}
