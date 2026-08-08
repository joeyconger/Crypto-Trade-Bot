import { getDb } from "../db/index.js";
import { env } from "../config/env.js";
import type { RiskConfig, TokenConfig } from "../types/index.js";

export interface RiskState {
  openPositionsCount: number;
  realizedPnlTodayUsd: number;
  dailyLossLimitUsd: number;
  haltedForDailyLoss: boolean;
}

function todayStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export function getRiskState(risk: RiskConfig): RiskState {
  const db = getDb();

  const openPositionsCount = (
    db.prepare(`SELECT COUNT(*) as n FROM trades WHERE status = 'open'`).get() as { n: number }
  ).n;

  const realizedPnlTodayUsd = (
    db
      .prepare(`SELECT COALESCE(SUM(pnl_usd), 0) as total FROM trades WHERE status = 'closed' AND closed_at >= ?`)
      .get(todayStartIso()) as { total: number }
  ).total;

  const dailyLossLimitUsd = env.PAPER_STARTING_BALANCE_USD * (risk.dailyLossLimitPct / 100);

  return {
    openPositionsCount,
    realizedPnlTodayUsd,
    dailyLossLimitUsd,
    haltedForDailyLoss: realizedPnlTodayUsd <= -dailyLossLimitUsd,
  };
}

/** Per-token position size, capped by the global max-position-size ceiling. */
export function computePositionSizeUsd(token: Pick<TokenConfig, "positionSizePct">, risk: RiskConfig): number {
  const pct = Math.min(token.positionSizePct, risk.maxPositionSizePct);
  return env.PAPER_STARTING_BALANCE_USD * (pct / 100);
}

export function canOpenPosition(risk: RiskConfig, state: RiskState): { allowed: boolean; reason?: string } {
  if (state.haltedForDailyLoss) {
    return {
      allowed: false,
      reason: `daily loss limit breached ($${Math.abs(state.realizedPnlTodayUsd).toFixed(2)} >= $${state.dailyLossLimitUsd.toFixed(2)}), trading halted for today`,
    };
  }
  if (state.openPositionsCount >= risk.maxConcurrentPositions) {
    return {
      allowed: false,
      reason: `max concurrent positions reached (${state.openPositionsCount}/${risk.maxConcurrentPositions})`,
    };
  }
  return { allowed: true };
}
