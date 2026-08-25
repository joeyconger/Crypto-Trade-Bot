import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { env } from "../config/env.js";

let cachedKeypair: Keypair | undefined;

/**
 * Loads the bot's own trading keypair from BOT_PRIVATE_KEY -- never the
 * user's Phantom wallet. Accepts either the base58 string `solana-keygen`
 * prints, or the raw JSON byte-array format (e.g. an id.json's contents)
 * pasted as a single env var value.
 */
export function getBotKeypair(): Keypair {
  if (cachedKeypair) return cachedKeypair;

  if (!env.BOT_PRIVATE_KEY) {
    throw new Error(
      "BOT_PRIVATE_KEY is not set -- required for live trading. Run `npm run generate-keypair` to create one.",
    );
  }

  const raw = env.BOT_PRIVATE_KEY.trim();
  const secretKey = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);

  cachedKeypair = Keypair.fromSecretKey(secretKey);
  return cachedKeypair;
}

/** The bot wallet's public address -- safe to display/share (unlike BOT_PRIVATE_KEY itself), needed to fund the wallet or look it up on Solscan. */
export function getBotPublicKeyString(): string {
  return getBotKeypair().publicKey.toBase58();
}
