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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Address-agnostic: works for a token mint (all swaps touching it) or a wallet (its own tx history). */
export async function getRecentTransactions(
  address: string,
  opts: { limit?: number; before?: string } = {},
  retries = 4,
): Promise<HeliusTransaction[]> {
  if (!env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY is not set");

  const url = new URL(`${BASE_URL}/addresses/${address}/transactions`);
  url.searchParams.set("api-key", env.HELIUS_API_KEY);
  url.searchParams.set("limit", String(opts.limit ?? 40));
  if (opts.before) url.searchParams.set("before", opts.before);

  // A 429 here usually means a shared rate-limit window is exhausted, not
  // that this one request was malformed -- back off meaningfully (up to
  // ~30s across 4 retries, same shape as geckoterminal.ts's gtGet) rather
  // than hammering the same window or throwing on the first hit. Found via
  // a real crash: an unpaced multi-page caller (src/wallet-cluster/) hit a
  // 429 on page 2 of a busy token and the whole run aborted with no retry
  // at all -- every caller of this function benefits from this fix, not
  // just that one.
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url);

    if (res.status === 429 && attempt < retries) {
      await sleep(3000 * Math.pow(1.8, attempt));
      continue;
    }

    const body = await res.json().catch(() => undefined);
    if (!res.ok) {
      throw new Error(`Helius transactions request failed (${res.status}): ${JSON.stringify(body)}`);
    }

    return Array.isArray(body) ? body : [];
  }

  throw new Error("unreachable"); // retries is finite, loop always returns or throws above
}
