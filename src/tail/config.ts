import { env } from "../config/env.js";

export interface TailConfig {
  enabled: boolean;
  // Only used at startup, to seed tail_wallets on a brand-new database (or
  // pick up an address added directly in Railway's env instead of the
  // dashboard). Once running, the DB (src/tail/db.ts's tail_wallets table)
  // is the live source of truth -- wallets added/removed via the dashboard
  // take effect immediately without a restart, so nothing downstream of
  // startup should read these two fields.
  envSeedWalletAddresses: string[];
  envSeedWalletLabels: Map<string, string>;
  positionSizePct: number;
  simulatedDelaySeconds: number;
  startingBalanceUsd: number;
  webhookSecret: string | undefined;
  // Helius webhook ID to keep in sync when a wallet is added/removed via the
  // dashboard -- see src/data/heliusWebhook.ts. Undefined means that sync is
  // skipped (you manage the webhook's address list manually in Helius).
  heliusWebhookId: string | undefined;
}

export function loadTailConfig(): TailConfig {
  const envSeedWalletAddresses = env.TAIL_WALLET_ADDRESSES.split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);

  // Index-aligned with envSeedWalletAddresses -- TAIL_WALLET_LABELS="omo,Sling"
  // labels the 1st and 2nd configured addresses respectively. A blank entry
  // (or a shorter labels list than addresses) just means that wallet falls
  // back to a shortened-address display elsewhere, never an error.
  const labelParts = env.TAIL_WALLET_LABELS.split(",").map((l) => l.trim());
  const envSeedWalletLabels = new Map<string, string>();
  envSeedWalletAddresses.forEach((address, i) => {
    const label = labelParts[i];
    if (label) envSeedWalletLabels.set(address, label);
  });

  return {
    // No longer gated on envSeedWalletAddresses.length -- the module can
    // start with zero wallets and have the first one added entirely through
    // the dashboard, now that tailing is DB-driven rather than fixed at
    // startup.
    enabled: env.TAIL_ENABLED,
    envSeedWalletAddresses,
    envSeedWalletLabels,
    positionSizePct: env.TAIL_POSITION_SIZE_PCT,
    simulatedDelaySeconds: env.TAIL_SIMULATED_DELAY_SECONDS,
    startingBalanceUsd: env.TAIL_STARTING_BALANCE_USD,
    webhookSecret: env.TAIL_WEBHOOK_SECRET,
    heliusWebhookId: env.TAIL_HELIUS_WEBHOOK_ID,
  };
}
