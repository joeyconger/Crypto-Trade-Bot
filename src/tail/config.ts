import { env } from "../config/env.js";

export interface TailConfig {
  enabled: boolean;
  walletAddresses: string[];
  positionSizePct: number;
  simulatedDelaySeconds: number;
  startingBalanceUsd: number;
  webhookSecret: string | undefined;
}

export function loadTailConfig(): TailConfig {
  const walletAddresses = env.TAIL_WALLET_ADDRESSES.split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);

  return {
    enabled: env.TAIL_ENABLED && walletAddresses.length > 0,
    walletAddresses,
    positionSizePct: env.TAIL_POSITION_SIZE_PCT,
    simulatedDelaySeconds: env.TAIL_SIMULATED_DELAY_SECONDS,
    startingBalanceUsd: env.TAIL_STARTING_BALANCE_USD,
    webhookSecret: env.TAIL_WEBHOOK_SECRET,
  };
}
