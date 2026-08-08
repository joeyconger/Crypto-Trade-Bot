import {
  getCircuitBreakerState,
  setWeeklyHalted,
  incrementOrResetConsecutiveLosses,
  setConsecutiveLossHalted,
  resumeConsecutiveLossHalt as dbResumeConsecutiveLossHalt,
  getRealizedPnlSince,
} from "../db/index.js";
import type { RiskConfig } from "../types/index.js";

function todayStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function sevenDaysAgoIso(): string {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

export interface CircuitBreakerCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Checked before every new entry -- blocks NEW positions only. Existing open
 * positions keep being managed for exit regardless of a halt; abandoning
 * risk management on what's already open just because new risk is paused
 * would be the wrong kind of "safety."
 *
 * Daily and weekly limits need no persisted "halted" flag of their own --
 * they're computed live from realized P&L, so daily naturally clears at UTC
 * midnight and weekly is a rolling 7-day window. Once a weekly or
 * consecutive-loss halt trips, it's recorded as sticky and stays tripped
 * (checked first, before recomputing) until a human resumes it.
 */
export function checkCircuitBreakers(mode: "paper" | "live", risk: RiskConfig, bankrollUsd: number): CircuitBreakerCheck {
  const state = getCircuitBreakerState();

  if (state.weekly_halted) {
    return { allowed: false, reason: "weekly loss limit halt is active -- needs manual review to resume" };
  }
  if (state.consecutive_loss_halted) {
    return {
      allowed: false,
      reason: `${state.consecutive_losses} consecutive losses -- needs manual review to resume`,
    };
  }

  const dailyPnl = getRealizedPnlSince(mode, todayStartIso());
  const dailyLimitUsd = bankrollUsd * (risk.dailyLossLimitPct / 100);
  if (dailyPnl <= -dailyLimitUsd) {
    return {
      allowed: false,
      reason: `daily loss limit breached ($${Math.abs(dailyPnl).toFixed(2)} >= $${dailyLimitUsd.toFixed(2)}), halted until next UTC day`,
    };
  }

  const weeklyPnl = getRealizedPnlSince(mode, sevenDaysAgoIso());
  const weeklyLimitUsd = bankrollUsd * (risk.weeklyLossLimitPct / 100);
  if (weeklyPnl <= -weeklyLimitUsd) {
    setWeeklyHalted(true);
    return {
      allowed: false,
      reason: `weekly loss limit breached ($${Math.abs(weeklyPnl).toFixed(2)} >= $${weeklyLimitUsd.toFixed(2)}), halted -- needs manual review to resume`,
    };
  }

  return { allowed: true };
}

/** Call once a trade fully closes -- updates the consecutive-loss streak and trips the sticky halt at the configured limit. */
export function recordTradeOutcome(pnlUsd: number, consecutiveLossLimit: number): void {
  const count = incrementOrResetConsecutiveLosses(pnlUsd < 0);
  if (count >= consecutiveLossLimit) {
    setConsecutiveLossHalted(true);
  }
}

export function resumeWeeklyHalt(): void {
  setWeeklyHalted(false);
}

export function resumeConsecutiveLossHalt(): void {
  dbResumeConsecutiveLossHalt();
}
