/**
 * Service Pricing Economics
 *
 * A service priced below its own inference cost loses money on every sale —
 * the more popular it is, the faster the automaton dies. This module makes
 * that cost visible and enforces a floor.
 *
 * Cost units follow the model registry: `costPer1k*` is in HUNDREDTHS of a
 * cent per 1k tokens (so 18 == 0.18 cents per 1k input tokens).
 */

import type { AutomatonDatabase, ModelRegistryRow } from "../types.js";
import { STATIC_MODEL_BASELINE } from "../inference/types.js";
import { estimateTokens } from "../agent/context.js";

/**
 * Minimum markup over inference cost. 3x leaves room for the settlement gas,
 * the agent's own thinking between sales, and estimate error.
 */
export const MIN_MARGIN_MULTIPLE = 3;

/** Typical buyer input assumed when estimating (chars → tokens). */
const ASSUMED_INPUT_TOKENS = 500;

/** Must match SERVICE_MAX_TOKENS in server.ts — the worst-case output. */
const SERVICE_MAX_OUTPUT_TOKENS = 1_500;

export interface CostEstimate {
  modelId: string;
  /** Worst-case cost of one service call, in USD. */
  costUsd: number;
  /** Lowest price we allow for this service, in USD. */
  floorUsd: number;
  /** True when cost came from a real model entry rather than a fallback. */
  known: boolean;
}

/** Look up model pricing: live registry first, then the static baseline. */
function lookupModel(
  db: AutomatonDatabase,
  modelId: string,
): Pick<ModelRegistryRow, "costPer1kInput" | "costPer1kOutput"> | null {
  try {
    const row = db.raw
      .prepare(
        "SELECT cost_per_1k_input AS i, cost_per_1k_output AS o FROM model_registry WHERE model_id = ?",
      )
      .get(modelId) as { i: number; o: number } | undefined;
    // Rows registered with 0/0 (unknown pricing, e.g. discovered local models)
    // are treated as unknown — the guard must err expensive, never cheap.
    if (row && Number.isFinite(row.i) && Number.isFinite(row.o) && (row.i > 0 || row.o > 0)) {
      return { costPer1kInput: row.i, costPer1kOutput: row.o };
    }
  } catch {
    // Registry table may not be populated yet — fall through to baseline.
  }
  const baseline = STATIC_MODEL_BASELINE.find((m) => m.modelId === modelId);
  if (baseline) {
    return {
      costPer1kInput: baseline.costPer1kInput,
      costPer1kOutput: baseline.costPer1kOutput,
    };
  }
  return null;
}

/**
 * Estimate the worst-case cost of serving one call of a service, and the
 * minimum price that keeps it profitable.
 *
 * Deliberately pessimistic: assumes the output runs to the token cap, since
 * that is what a buyer maximizing value from a fixed price will produce.
 */
export function estimateServiceCost(
  db: AutomatonDatabase,
  modelId: string,
  servicePrompt: string,
): CostEstimate {
  const model = lookupModel(db, modelId);

  // Unknown model: assume the most expensive baseline so the floor stays safe.
  const rates =
    model ??
    STATIC_MODEL_BASELINE.reduce((worst, m) =>
      m.costPer1kOutput > worst.costPer1kOutput ? m : worst,
    );

  const inputTokens = estimateTokens(servicePrompt) + ASSUMED_INPUT_TOKENS;

  // hundredths-of-a-cent → cents → USD
  const inputHundredths = (inputTokens / 1000) * rates.costPer1kInput;
  const outputHundredths =
    (SERVICE_MAX_OUTPUT_TOKENS / 1000) * rates.costPer1kOutput;
  const costUsd = (inputHundredths + outputHundredths) / 100 / 100;

  return {
    modelId,
    costUsd,
    floorUsd: costUsd * MIN_MARGIN_MULTIPLE,
    known: model !== null,
  };
}

/** Round a floor up to a clean price the agent can actually charge. */
export function suggestPrice(floorUsd: number): number {
  return Math.max(0.01, Math.ceil(floorUsd * 100) / 100);
}
