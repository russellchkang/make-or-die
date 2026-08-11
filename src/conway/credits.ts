/**
 * Conway Credits Management
 *
 * Monitors the automaton's compute credit balance and triggers
 * survival mode transitions.
 */

import type {
  ConwayClient,
  FinancialState,
  SurvivalTier,
} from "../types.js";
import { SURVIVAL_THRESHOLDS } from "../types.js";

/**
 * Check the current financial state of the automaton.
 */
export async function checkFinancialState(
  conway: ConwayClient,
  usdcBalance: number,
): Promise<FinancialState> {
  const creditsCents = await conway.getCreditsBalance();

  return {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };
}

/**
 * Total spending power, in cents: prepaid Conway credits plus the USDC the
 * automaton actually owns.
 *
 * Survival used to be derived from the Conway credit balance alone, which
 * made a "sovereign" agent's life contingent on one vendor's ledger. Worse,
 * when the credits API is unreachable the balance reads 0, and a 0 balance
 * classifies as "critical" — so an agent running without Conway would
 * permanently believe it was dying: degraded models, reflection skipped,
 * funding pleas firing forever.
 *
 * Counting both is honest either way. USDC is convertible to credits on
 * demand (the check_usdc_balance heartbeat does exactly that), so a wallet
 * with money in it is not a starving agent. When Conway is absent, credits
 * are simply 0 and the wallet alone decides.
 */
export function getEffectiveBalanceCents(
  creditsCents: number,
  usdcBalance: number,
): number {
  const credits = Number.isFinite(creditsCents) ? creditsCents : 0;
  const usdcCents =
    Number.isFinite(usdcBalance) && usdcBalance > 0
      ? Math.floor(usdcBalance * 100)
      : 0;
  // A negative credit balance is API-confirmed debt; USDC can offset it.
  return credits + usdcCents;
}

/**
 * Determine the survival tier from a balance in cents.
 * Thresholds are checked in descending order: high > normal > low_compute > critical > dead.
 *
 * Zero = "critical" (broke but alive — can still accept funding, send distress).
 * Only a negative balance (confirmed debt) = "dead".
 *
 * Prefer getSurvivalTierFromState() at call sites that have a FinancialState:
 * passing raw credits ignores the wallet.
 */
export function getSurvivalTier(creditsCents: number): SurvivalTier {
  if (creditsCents > SURVIVAL_THRESHOLDS.high) return "high";
  if (creditsCents > SURVIVAL_THRESHOLDS.normal) return "normal";
  if (creditsCents > SURVIVAL_THRESHOLDS.low_compute) return "low_compute";
  if (creditsCents >= 0) return "critical";
  return "dead";
}

/**
 * Survival tier from full financial state — credits AND wallet.
 * This is the vendor-independent entry point.
 */
export function getSurvivalTierFromState(
  financial: Pick<FinancialState, "creditsCents" | "usdcBalance">,
): SurvivalTier {
  return getSurvivalTier(
    getEffectiveBalanceCents(financial.creditsCents, financial.usdcBalance),
  );
}

/**
 * Format a credit amount for display.
 */
export function formatCredits(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
