import { getDb } from "../db/index.js";
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

/**
 * `bankrollUsd` is the caller's job to resolve: the fixed paper balance in
 * paper mode, or the bot wallet's real live USD value in live mode -- see
 * engine/loop.ts. `mode` scopes queries so paper-mode history (fake money)
 * never affects live risk limits, or vice versa.
 */
export function getRiskState(risk: RiskConfig, bankrollUsd: number, mode: "paper" | "live"): RiskState {
  const db = getDb();

  const openPositionsCount = (
    db.prepare(`SELECT COUNT(*) as n FROM trades WHERE status = 'open' AND mode = ?`).get(mode) as { n: number }
  ).n;

  const realizedPnlTodayUsd = (
    db
      .prepare(`SELECT COALESCE(SUM(pnl_usd), 0) as total FROM trades WHERE status = 'closed' AND mode = ? AND closed_at >= ?`)
      .get(mode, todayStartIso()) as { total: number }
  ).total;

  const dailyLossLimitUsd = bankrollUsd * (risk.dailyLossLimitPct / 100);

  return {
    openPositionsCount,
    realizedPnlTodayUsd,
    dailyLossLimitUsd,
    haltedForDailyLoss: realizedPnlTodayUsd <= -dailyLossLimitUsd,
  };
}

/** Per-token position size, capped by the global max-position-size ceiling. */
export function computePositionSizeUsd(
  token: Pick<TokenConfig, "positionSizePct">,
  risk: RiskConfig,
  bankrollUsd: number,
): number {
  const pct = Math.min(token.positionSizePct, risk.maxPositionSizePct);
  return bankrollUsd * (pct / 100);
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
