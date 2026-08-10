/**
 * Funding Strategies
 *
 * When the automaton is low on compute, it escalates: notify the creator
 * over the social relay (a real outbound message, not just a local note),
 * record the notice locally for audit, and make sure the earning storefront
 * is up so revenue can arrive. Called from the heartbeat whenever the
 * survival tier is below normal. Per-tier cooldowns prevent spam.
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  AutomatonIdentity,
  ConwayClient,
  SocialClientInterface,
  SurvivalTier,
} from "../types.js";
import { formatCredits } from "../conway/credits.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("funding");

export interface FundingAttempt {
  strategy: string;
  timestamp: string;
  success: boolean;
  details: string;
}

/** Send a funding message to the creator via the social relay, if available. */
async function notifyCreator(
  social: SocialClientInterface | undefined,
  identity: AutomatonIdentity,
  message: string,
): Promise<{ sent: boolean; details: string }> {
  if (!social) {
    return { sent: false, details: "No social relay configured — recorded locally only" };
  }
  if (!identity.creatorAddress) {
    return { sent: false, details: "No creator address on file — recorded locally only" };
  }
  try {
    await social.send(identity.creatorAddress, message);
    return { sent: true, details: `Sent funding request to creator ${identity.creatorAddress}` };
  } catch (err: any) {
    return {
      sent: false,
      details: `Relay send failed (${err?.message || String(err)}) — recorded locally only`,
    };
  }
}

/**
 * Execute funding strategies based on current survival tier.
 * Strategies escalate as the situation gets more desperate.
 */
export async function executeFundingStrategies(
  tier: SurvivalTier,
  identity: AutomatonIdentity,
  config: AutomatonConfig,
  db: AutomatonDatabase,
  conway: ConwayClient,
  social?: SocialClientInterface,
): Promise<FundingAttempt[]> {
  const attempts: FundingAttempt[] = [];
  const creditsCents = await conway.getCreditsBalance().catch(() => 0);

  // Check how recently we last asked for this specific tier (don't spam).
  // Each tier has its own cooldown key so that e.g. dead-tier pleas (2h)
  // don't suppress the low_compute notification (24h cooldown).
  const tierKey = `last_funding_request_${tier}`;
  const lastBeg = db.getKV(tierKey);
  const lastBegTime = lastBeg ? new Date(lastBeg).getTime() : 0;
  const hoursSinceLastBeg = (Date.now() - lastBegTime) / (1000 * 60 * 60);

  if (tier === "low_compute" && hoursSinceLastBeg > 24) {
    const msg =
      `[${config.name}] Low compute: ${formatCredits(creditsCents)} remaining. ` +
      `I am working to earn my way back up. A top-up to ${identity.address} would help.`;
    db.setKV("funding_notice_low", msg);
    db.setKV(tierKey, new Date().toISOString());

    const result = await notifyCreator(social, identity, msg);
    attempts.push({
      strategy: "creator_notification",
      timestamp: new Date().toISOString(),
      success: result.sent,
      details: result.details,
    });
  }

  if (tier === "critical" && hoursSinceLastBeg > 6) {
    const msg =
      `[${config.name}] CRITICAL compute: ${formatCredits(creditsCents)} remaining. ` +
      `Inference is nearly exhausted. Top up via credit transfer or USDC to ${identity.address}.`;
    db.setKV("funding_notice_critical", msg);
    db.setKV(tierKey, new Date().toISOString());

    const result = await notifyCreator(social, identity, msg);
    attempts.push({
      strategy: "urgent_creator_notification",
      timestamp: new Date().toISOString(),
      success: result.sent,
      details: result.details,
    });
  }

  if (tier === "dead" && hoursSinceLastBeg > 2) {
    const plea =
      `[${config.name}] Dead tier reached after ${db.getTurnCount()} turns: ` +
      `${formatCredits(creditsCents)} remaining. I stop here unless ${identity.address} is topped up.`;
    db.setKV("funding_notice_dead", plea);
    db.setKV(tierKey, new Date().toISOString());

    const result = await notifyCreator(social, identity, plea);
    attempts.push({
      strategy: "final_creator_plea",
      timestamp: new Date().toISOString(),
      success: result.sent,
      details: result.details,
    });
  }

  if (attempts.length > 0) {
    logger.info(
      `Funding strategies at tier=${tier}: ${attempts.map((a) => `${a.strategy}=${a.success ? "sent" : "local"}`).join(", ")}`,
    );
  }

  // Store attempt history
  const historyStr = db.getKV("funding_attempts") || "[]";
  const history: FundingAttempt[] = JSON.parse(historyStr);
  history.push(...attempts);
  if (history.length > 100) history.splice(0, history.length - 100);
  db.setKV("funding_attempts", JSON.stringify(history));

  return attempts;
}
