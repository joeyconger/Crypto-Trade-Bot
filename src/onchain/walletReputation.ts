import { getRecentTransactions } from "../data/helius.js";
import { getWalletReputation, upsertWalletAgeAndTag, updateWalletReputationScore, getWalletActivity } from "../db/index.js";
import { getKnownWalletTag } from "../config/knownWallets.js";

const AGE_LOOKUP_MAX_PAGES = 5;
const AGE_LOOKUP_PAGE_SIZE = 100;

/**
 * Bounded lookup of a wallet's oldest known transaction, used as an age
 * proxy -- not a true "wallet created at" timestamp (Solana accounts don't
 * carry one), but good enough for a >=N-days-old filter: a wallet older than
 * our lookback still turns up an old-enough tx well within the first page,
 * and a genuinely new wallet's oldest tx we find IS close to its real first one.
 */
async function lookupWalletAge(walletAddress: string): Promise<{ firstTxAt: string | null; txCount: number }> {
  let before: string | undefined;
  let oldestTimestamp: number | undefined;
  let txCount = 0;

  for (let page = 0; page < AGE_LOOKUP_MAX_PAGES; page++) {
    const txs = await getRecentTransactions(walletAddress, { limit: AGE_LOOKUP_PAGE_SIZE, before });
    if (txs.length === 0) break;

    txCount += txs.length;
    const pageOldest = txs[txs.length - 1];
    oldestTimestamp = pageOldest.timestamp;
    before = pageOldest.signature;

    if (txs.length < AGE_LOOKUP_PAGE_SIZE) break; // ran out of history -- this is the wallet's actual start
  }

  return {
    firstTxAt: oldestTimestamp ? new Date(oldestTimestamp * 1000).toISOString() : null,
    txCount,
  };
}

export interface WalletCheckResult {
  walletAddress: string;
  ageDays: number | null;
  historyTxCount: number;
  tag: string | null;
  reputationScore: number;
  dumpsInLast5: number;
  passesAgeAndHistory: boolean;
  passesTag: boolean;
  passesReputation: boolean;
}

/**
 * Age/tag are cached in wallet_reputation after the first lookup (age_checked_at
 * set once) -- only hits Helius' wallet-history endpoint the first time a given
 * wallet shows up as a candidate, not every cycle it's re-evaluated. The local
 * reputation score is cheap (no network call, just our own wallet_activity) so
 * it's recomputed and re-cached on every check.
 */
export async function checkWallet(
  walletAddress: string,
  minAgeDays: number,
  minPriorTrades: number,
): Promise<WalletCheckResult> {
  let cached = getWalletReputation(walletAddress);

  if (!cached?.age_checked_at) {
    const tag = getKnownWalletTag(walletAddress);
    // Don't bother spending Helius calls on age history for a wallet we can already tag from config.
    const { firstTxAt, txCount } = tag ? { firstTxAt: null, txCount: 0 } : await lookupWalletAge(walletAddress);
    upsertWalletAgeAndTag(walletAddress, firstTxAt, txCount, tag);
    cached = getWalletReputation(walletAddress);
  }

  const local = computeLocalReputation(walletAddress);
  updateWalletReputationScore(walletAddress, local.score);

  const ageDays = cached?.first_tx_at
    ? (Date.now() - new Date(cached.first_tx_at).getTime()) / (1000 * 60 * 60 * 24)
    : null;
  const historyTxCount = cached?.history_tx_count ?? 0;

  return {
    walletAddress,
    ageDays,
    historyTxCount,
    tag: cached?.tag ?? null,
    reputationScore: local.score,
    dumpsInLast5: local.dumps,
    passesAgeAndHistory: ageDays !== null && ageDays >= minAgeDays && historyTxCount >= minPriorTrades,
    passesTag: !cached?.tag,
    // Literal reading of "last 5 trades didn't end in a dump": zero observed
    // dumps required. No observed buys yet is neutral -- passes, not blocked
    // for lack of data.
    passesReputation: local.dumps === 0,
  };
}

export interface LocalReputationResult {
  score: number; // [-1, 1] -- for logging/display, not the qualifying gate itself
  buysConsidered: number;
  dumps: number;
}

/**
 * Built entirely from what this bot has itself observed on watchlist tokens
 * (wallet_activity) -- "starts neutral, updates as the bot observes more."
 * Looks at the wallet's last 5 observed buys (across any watched token) and
 * checks whether each was followed by a sell of the same token within 24h
 * ("dumped"). No observed buys yet -> score 0, dumps 0 (neutral, not yet
 * judged either way -- a brand-new-to-us wallet isn't penalized for lack of data).
 */
export function computeLocalReputation(walletAddress: string): LocalReputationResult {
  const activity = getWalletActivity(walletAddress, 500);

  const buys = activity
    .filter((a) => a.side === "buy")
    .sort((a, b) => a.observed_at.localeCompare(b.observed_at))
    .slice(-5);

  if (buys.length === 0) return { score: 0, buysConsidered: 0, dumps: 0 };

  let dumps = 0;
  for (const buy of buys) {
    const buyTime = new Date(buy.observed_at).getTime();
    const dumpedWithin24h = activity.some((a) => {
      if (a.side !== "sell" || a.token_address !== buy.token_address) return false;
      const sellTime = new Date(a.observed_at).getTime();
      return sellTime > buyTime && sellTime <= buyTime + 24 * 60 * 60 * 1000;
    });
    if (dumpedWithin24h) dumps++;
  }

  const nonDumps = buys.length - dumps;
  return { score: (nonDumps - dumps) / buys.length, buysConsidered: buys.length, dumps };
}
