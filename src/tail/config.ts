import { env } from "../config/env.js";

export interface TailConfig {
  enabled: boolean;
  walletAddresses: string[];
  walletLabels: Map<string, string>; // address -> display label, only for addresses that have one configured
  positionSizePct: number;
  simulatedDelaySeconds: number;
  startingBalanceUsd: number;
  webhookSecret: string | undefined;
}

export function loadTailConfig(): TailConfig {
  const walletAddresses = env.TAIL_WALLET_ADDRESSES.split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);

  // Index-aligned with walletAddresses -- TAIL_WALLET_LABELS="omo,Sling"
  // labels the 1st and 2nd configured addresses respectively. A blank entry
  // (or a shorter labels list than addresses) just means that wallet falls
  // back to a shortened-address display elsewhere, never an error.
  const labelParts = env.TAIL_WALLET_LABELS.split(",").map((l) => l.trim());
  const walletLabels = new Map<string, string>();
  walletAddresses.forEach((address, i) => {
    const label = labelParts[i];
    if (label) walletLabels.set(address, label);
  });

  return {
    enabled: env.TAIL_ENABLED && walletAddresses.length > 0,
    walletAddresses,
    walletLabels,
    positionSizePct: env.TAIL_POSITION_SIZE_PCT,
    simulatedDelaySeconds: env.TAIL_SIMULATED_DELAY_SECONDS,
    startingBalanceUsd: env.TAIL_STARTING_BALANCE_USD,
    webhookSecret: env.TAIL_WEBHOOK_SECRET,
  };
}
