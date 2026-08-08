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

export function getConnection(): Connection {
  if (cachedConnection) return cachedConnection;
  cachedConnection = new Connection(resolveRpcUrl(), "confirmed");
  return cachedConnection;
}
