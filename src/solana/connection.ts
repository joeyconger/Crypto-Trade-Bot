import { Connection } from "@solana/web3.js";
import { env } from "../config/env.js";

let cachedConnection: Connection | undefined;

const PUBLIC_DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

// If the user never overrode SOLANA_RPC_URL but did set a Helius key, use
// Helius's RPC by default -- meaningfully more reliable than the public
// endpoint, and avoids making the user hand-construct the URL themselves.
function resolveRpcUrl(): string {
  if (env.SOLANA_RPC_URL === PUBLIC_DEFAULT_RPC && env.HELIUS_API_KEY) {
    return `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  }
  return env.SOLANA_RPC_URL;
}

// Bounds every RPC HTTP call the Connection makes -- @solana/web3.js's
// default fetch has no timeout of its own, so an RPC endpoint that accepts
// a connection but never responds could otherwise hang a call indefinitely.
// Live buys/sells serialize through one queue (see tail/liveExecution.ts's
// serializeLiveExecution), so an unbounded RPC call here would block every
// later live trade, not just the one it belongs to.
const RPC_TIMEOUT_MS = 20_000;
function fetchWithTimeout(...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
  const [input, init] = args;
  return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(RPC_TIMEOUT_MS) });
}

export function getConnection(): Connection {
  if (cachedConnection) return cachedConnection;
  cachedConnection = new Connection(resolveRpcUrl(), {
    commitment: "confirmed",
    // confirmTransaction's blockhash-expiry polling is already bounded
    // (~60-90s), but this bounds the whole confirmation wait explicitly
    // too, rather than relying solely on that implicit ceiling.
    confirmTransactionInitialTimeout: 45_000,
    fetch: fetchWithTimeout,
  });
  return cachedConnection;
}
