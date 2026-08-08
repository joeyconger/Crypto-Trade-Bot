import { env } from "../config/env.js";

const BASE_URL = "https://api.helius.xyz/v0";

export interface HeliusTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  tokenAmount: number;
  mint: string;
}

export interface HeliusNativeTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount: number; // lamports
}

export interface HeliusTransaction {
  signature: string;
  timestamp: number;
  type: string;
  feePayer: string;
  tokenTransfers: HeliusTokenTransfer[];
  nativeTransfers: HeliusNativeTransfer[];
}

/** Address-agnostic: works for a token mint (all swaps touching it) or a wallet (its own tx history). */
export async function getRecentTransactions(
  address: string,
  opts: { limit?: number; before?: string } = {},
): Promise<HeliusTransaction[]> {
  if (!env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY is not set");

  const url = new URL(`${BASE_URL}/addresses/${address}/transactions`);
  url.searchParams.set("api-key", env.HELIUS_API_KEY);
  url.searchParams.set("limit", String(opts.limit ?? 40));
  if (opts.before) url.searchParams.set("before", opts.before);

  const res = await fetch(url);
  const body = await res.json().catch(() => undefined);

  if (!res.ok) {
    throw new Error(`Helius transactions request failed (${res.status}): ${JSON.stringify(body)}`);
  }

  return Array.isArray(body) ? body : [];
}
