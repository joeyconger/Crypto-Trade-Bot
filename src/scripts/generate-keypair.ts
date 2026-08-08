/**
 * Generates a fresh Solana keypair for the bot to trade with. Run this
 * yourself (locally, or in a Railway shell) rather than asking anyone else
 * to run it for you -- the secret key it prints should never appear in a
 * chat log or anywhere else outside your own env vars.
 *
 * `npm run generate-keypair`
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const keypair = Keypair.generate();

console.log("Public key -- fund this address from Phantom (send SOL, nothing else needed):");
console.log(`  ${keypair.publicKey.toBase58()}`);
console.log("\nBOT_PRIVATE_KEY -- put this in your .env / Railway env vars, never commit it, never share it:");
console.log(`  ${bs58.encode(keypair.secretKey)}`);
