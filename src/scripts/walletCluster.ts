/**
 * Wallet-clustering / side-wallet detection -- `npm run wallet-cluster -- --wallet <address>`
 *
 * Correlation-based inference, NOT proof of identity or ownership. Every
 * output is a confidence score, never a definitive claim. Read-only
 * analysis -- no execution path exists anywhere in this module.
 *
 * Flags:
 *   --wallet <address>        required -- the main wallet to analyze
 *   --pre-buy-window <min>    default 60
 *   --min-overlap <n>         default 4
 *   --max-tokens <n>          default 15 -- how many of the wallet's recent buys to sample
 *
 * Requires real network access to Helius (this sandbox has none -- see
 * README's "Wallet clustering" section). Run this from somewhere with real
 * network access before trusting any output.
 */
import { getDb } from "../db/index.js";
import { initWalletClusterSchema } from "../wallet-cluster/db.js";
import { runWalletClusterPipeline } from "../wallet-cluster/pipeline.js";
import { formatWalletClusterReport } from "../wallet-cluster/report.js";
import { DEFAULT_WALLET_CLUSTER_CONFIG } from "../wallet-cluster/types.js";

function parseArgs(argv: string[]) {
  let wallet: string | undefined;
  let preBuyWindowMinutes = DEFAULT_WALLET_CLUSTER_CONFIG.preBuyWindowMinutes;
  let minOverlapCount = DEFAULT_WALLET_CLUSTER_CONFIG.minOverlapCount;
  let maxTokensToAnalyze = DEFAULT_WALLET_CLUSTER_CONFIG.maxTokensToAnalyze;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--wallet") wallet = argv[++i];
    else if (argv[i] === "--pre-buy-window") preBuyWindowMinutes = Number(argv[++i]);
    else if (argv[i] === "--min-overlap") minOverlapCount = Number(argv[++i]);
    else if (argv[i] === "--max-tokens") maxTokensToAnalyze = Number(argv[++i]);
  }

  if (!wallet) throw new Error("--wallet <address> is required");
  return { wallet, preBuyWindowMinutes, minOverlapCount, maxTokensToAnalyze };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  getDb();
  initWalletClusterSchema();

  console.log(`Analyzing ${args.wallet}...`);
  console.log(`(this is correlation-based inference -- see README before trusting any score as more than exploratory)\n`);

  const result = await runWalletClusterPipeline({
    mainWallet: args.wallet,
    config: {
      ...DEFAULT_WALLET_CLUSTER_CONFIG,
      preBuyWindowMinutes: args.preBuyWindowMinutes,
      minOverlapCount: args.minOverlapCount,
      maxTokensToAnalyze: args.maxTokensToAnalyze,
    },
    onProgress: (msg) => console.log(msg),
  });

  console.log("\n" + formatWalletClusterReport(result));
}

main().catch((err) => {
  console.error("Wallet-cluster analysis failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
