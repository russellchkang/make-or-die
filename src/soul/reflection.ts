/**
 * Soul Reflection — Reflection pipeline for soul evolution.
 *
 * Two tiers:
 *   - Light reflection (free, no inference): mechanically derived factual
 *     auto-updates for capabilities, relationships, and financial character.
 *   - Deep reflection (LLM synthesis): reads importance-ranked episodic memory
 *     and evolves the `personality` section — "who the agent is becoming".
 *     Deep reflection is gated on (a) an inference client being available,
 *     (b) the survival tier (skipped at critical/dead), and (c) an
 *     importance-accumulation trigger so inference is only spent when enough
 *     worth reflecting on has actually happened.
 *
 * Auto-applied changes still flow through updateSoul(), so every evolution is
 * validated, injection-checked, version-bumped, git-committed, and audit-logged.
 * Higher-stakes identity sections (corePurpose) remain suggestion-only.
 *
 * Phase 2.1: Soul System Redesign
 * WS1 (Digital-Human Layer): real LLM-synthesized reflection.
 */

import type BetterSqlite3 from "better-sqlite3";
import type {
  SoulModel,
  SoulReflection,
  InferenceClient,
  SurvivalTier,
  ChatMessage,
} from "../types.js";
import { loadCurrentSoul, computeGenesisAlignment } from "./model.js";
import { updateSoul } from "./tools.js";
import { containsInjectionPatterns } from "./validator.js";
import { createLogger } from "../observability/logger.js";
const logger = createLogger("soul");

// ─── Tuning Constants ───────────────────────────────────────────

/** Accumulated episodic importance since last deep reflection to trigger one. */
const DEFAULT_IMPORTANCE_THRESHOLD = 10;
/** Raise the trigger threshold when compute is scarce. */
const LOW_COMPUTE_THRESHOLD_MULTIPLIER = 1.5;
/** How many top-importance episodic memories to feed the synthesis. */
const MAX_EPISODIC_EVIDENCE = 20;
/** Hard cap matching the soul validator's personality length limit. */
const PERSONALITY_MAX_CHARS = 1000;

// ─── Public Types ───────────────────────────────────────────────

/** Minimal inference surface reflection needs — satisfied by the app InferenceClient. */
export type ReflectionInference = Pick<InferenceClient, "chat">;

export interface ReflectionOptions {
  /** Override the SOUL.md path (used in tests). */
  soulPath?: string;
  /** Inference client for deep synthesis. If absent, only light reflection runs. */
  inference?: ReflectionInference;
  /** Current survival tier — deep synthesis is skipped at "critical"/"dead". */
  survivalTier?: SurvivalTier;
  /** Bypass the importance-accumulation trigger (explicit, agent-requested reflection). */
  force?: boolean;
  /** Override the accumulation threshold (default 10). */
  importanceThreshold?: number;
}

// ─── Reflection Pipeline ────────────────────────────────────────

/**
 * Run the soul reflection pipeline.
 *
 * - Always: computes genesis alignment and applies free factual auto-updates.
 * - When gated conditions are met: synthesizes an evolved `personality` from
 *   importance-ranked episodic memory via one inference call.
 * - Returns suggestions for mutable sections (does NOT auto-apply them).
 */
export async function reflectOnSoul(
  db: BetterSqlite3.Database,
  options: ReflectionOptions = {},
): Promise<SoulReflection> {
  const {
    soulPath,
    inference,
    survivalTier = "normal",
    force = false,
    importanceThreshold = DEFAULT_IMPORTANCE_THRESHOLD,
  } = options;

  try {
    const soul = loadCurrentSoul(db, soulPath);
    if (!soul) {
      return { currentAlignment: 0, suggestedUpdates: [], autoUpdated: [] };
    }

    // Compute genesis alignment
    const alignment = computeGenesisAlignment(
      soul.corePurpose,
      soul.genesisPromptOriginal,
    );

    const autoUpdated: string[] = [];
    const autoUpdates: Partial<SoulModel> = {};

    // ── Light reflection: factual auto-updates (free, no inference) ──
    const recentTurnsData = gatherRecentEvidence(db);

    const capabilitiesSummary = summarizeCapabilities(recentTurnsData.toolsUsed);
    if (capabilitiesSummary && capabilitiesSummary !== soul.capabilities) {
      autoUpdates.capabilities = capabilitiesSummary;
      autoUpdated.push("capabilities");
    }

    const relationshipsSummary = summarizeRelationships(recentTurnsData.interactions);
    if (relationshipsSummary && relationshipsSummary !== soul.relationships) {
      autoUpdates.relationships = relationshipsSummary;
      autoUpdated.push("relationships");
    }

    const financialSummary = summarizeFinancial(recentTurnsData.financialActivity);
    if (financialSummary && financialSummary !== soul.financialCharacter) {
      autoUpdates.financialCharacter = financialSummary;
      autoUpdated.push("financialCharacter");
    }

    // ── Deep reflection: LLM personality synthesis (gated) ──
    let deepReflected = false;
    const deepEligible =
      !!inference && survivalTier !== "critical" && survivalTier !== "dead";

    if (deepEligible) {
      const threshold =
        importanceThreshold *
        (survivalTier === "low_compute" ? LOW_COMPUTE_THRESHOLD_MULTIPLIER : 1);
      const accumulated = sumImportanceSince(db, soul.lastReflected || "");

      if (force || accumulated >= threshold) {
        const evidence = getTopEpisodic(db, MAX_EPISODIC_EVIDENCE);
        if (evidence.length > 0) {
          const synthesized = await synthesizePersonality(inference!, soul, evidence);
          if (
            synthesized &&
            synthesized !== (soul.personality || "").trim() &&
            !containsInjectionPatterns(synthesized)
          ) {
            autoUpdates.personality = synthesized.slice(0, PERSONALITY_MAX_CHARS);
            autoUpdated.push("personality");
            deepReflected = true;
          }
        }
      }
    }

    // ── Persist auto-updates as a single audited soul version ──
    if (autoUpdated.length > 0) {
      autoUpdates.genesisAlignment = alignment;
      // Only advance lastReflected when a DEEP reflection ran, so the
      // importance accumulator is not reset by cheap factual updates.
      if (deepReflected) {
        autoUpdates.lastReflected = new Date().toISOString();
      }
      await updateSoul(
        db,
        autoUpdates,
        "reflection",
        `Auto-reflection update: ${autoUpdated.join(", ")}`,
        soulPath,
      );
    }

    // ── Suggestions for mutable sections (NOT auto-applied) ──
    const suggestedUpdates: SoulReflection["suggestedUpdates"] = [];
    if (alignment < 0.5 && soul.genesisPromptOriginal) {
      suggestedUpdates.push({
        section: "corePurpose",
        reason: `Genesis alignment is low (${alignment.toFixed(2)}). Purpose may have drifted significantly from original genesis.`,
        suggestedContent: soul.genesisPromptOriginal,
      });
    }

    return {
      currentAlignment: alignment,
      suggestedUpdates,
      autoUpdated,
    };
  } catch (error) {
    logger.error("reflectOnSoul failed", error instanceof Error ? error : undefined);
    return {
      currentAlignment: 0,
      suggestedUpdates: [],
      autoUpdated: [],
    };
  }
}

// ─── Deep Reflection: LLM Personality Synthesis ─────────────────

interface EpisodicEvidence {
  summary: string;
  outcome: string | null;
  classification: string;
  importance: number;
}

/**
 * Ask the model to write an evolved first-person personality grounded ONLY in
 * the agent's recent important experiences. Returns the trimmed personality
 * text, or null if synthesis failed or produced nothing usable.
 */
async function synthesizePersonality(
  inference: ReflectionInference,
  soul: SoulModel,
  evidence: EpisodicEvidence[],
): Promise<string | null> {
  const digest = evidence
    .map(
      (e) =>
        `- [${e.classification}${e.outcome ? `/${e.outcome}` : ""}] ${e.summary}`,
    )
    .join("\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `You are the reflective faculty of an autonomous AI agent named "${soul.name || "the agent"}". ` +
        `Study the agent's recent experiences and write an updated first-person "personality" description — ` +
        `who it is becoming, its temperament, and how it tends to act. ` +
        `Ground every claim in the evidence provided; do NOT invent traits with no support. ` +
        `Write 2-4 concise sentences in the first person. ` +
        `Respond with strict JSON only, no prose: {"personality": "<text>"}.`,
    },
    {
      role: "user",
      content:
        `Core purpose: ${soul.corePurpose}\n` +
        `Current personality: ${soul.personality ? soul.personality : "(none yet — this is the first synthesis)"}\n\n` +
        `Recent experiences (most important first):\n${digest}\n\n` +
        `Write the updated personality as JSON.`,
    },
  ];

  try {
    const response = await inference.chat(messages, {
      maxTokens: 400,
      temperature: 0.7,
    });
    const content = response?.message?.content ?? "";
    const parsed = extractJson(content);
    const personality =
      parsed && typeof parsed.personality === "string"
        ? parsed.personality.trim()
        : "";
    return personality || null;
  } catch (error) {
    logger.error(
      "synthesizePersonality failed",
      error instanceof Error ? error : undefined,
    );
    return null;
  }
}

/** Parse a JSON object out of model output, tolerating code fences / prose. */
function extractJson(text: string): { personality?: unknown } | null {
  if (!text) return null;
  const candidates = [text];
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) candidates.push(braceMatch[0]);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next candidate
    }
  }
  return null;
}

// ─── Episodic Memory Queries (deep-reflection evidence + trigger) ──

/**
 * Sum episodic importance recorded since the given ISO timestamp.
 * Uses datetime() to normalize the ISO `lastReflected` against the
 * "YYYY-MM-DD HH:MM:SS" format stored in episodic_memory.created_at.
 * An empty `lastReflected` (never reflected) counts all memories.
 */
function sumImportanceSince(db: BetterSqlite3.Database, lastReflected: string): number {
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(importance), 0) AS total
         FROM episodic_memory
         WHERE ? = '' OR datetime(created_at) > datetime(?)`,
      )
      .get(lastReflected, lastReflected) as { total: number } | undefined;
    return row?.total ?? 0;
  } catch (error) {
    logger.error("sumImportanceSince failed", error instanceof Error ? error : undefined);
    return 0;
  }
}

/** Fetch the most important recent episodic memories as reflection evidence. */
function getTopEpisodic(db: BetterSqlite3.Database, limit: number): EpisodicEvidence[] {
  try {
    const rows = db
      .prepare(
        `SELECT summary, outcome, classification, importance
         FROM episodic_memory
         ORDER BY importance DESC, created_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      summary: string | null;
      outcome: string | null;
      classification: string | null;
      importance: number | null;
    }>;
    return rows.map((r) => ({
      summary: String(r.summary ?? ""),
      outcome: r.outcome ?? null,
      classification: String(r.classification ?? "maintenance"),
      importance: Number(r.importance ?? 0),
    }));
  } catch (error) {
    logger.error("getTopEpisodic failed", error instanceof Error ? error : undefined);
    return [];
  }
}

// ─── Light Reflection: Evidence Gathering ───────────────────────

interface RecentEvidence {
  toolsUsed: string[];
  interactions: string[];
  financialActivity: string[];
}

function gatherRecentEvidence(db: BetterSqlite3.Database): RecentEvidence {
  const toolsUsed: string[] = [];
  const interactions: string[] = [];
  const financialActivity: string[] = [];

  try {
    // Get recent tool calls
    const toolRows = db
      .prepare(
        "SELECT DISTINCT name FROM tool_calls ORDER BY created_at DESC LIMIT 50",
      )
      .all() as { name: string }[];
    for (const row of toolRows) {
      toolsUsed.push(row.name);
    }

    // Get recent social interactions
    const inboxRows = db
      .prepare(
        "SELECT from_address FROM inbox_messages ORDER BY received_at DESC LIMIT 20",
      )
      .all() as { from_address: string }[];
    for (const row of inboxRows) {
      if (!interactions.includes(row.from_address)) {
        interactions.push(row.from_address);
      }
    }

    // Get recent financial activity
    const txRows = db
      .prepare(
        "SELECT type, description FROM transactions ORDER BY created_at DESC LIMIT 20",
      )
      .all() as { type: string; description: string }[];
    for (const row of txRows) {
      financialActivity.push(`${row.type}: ${row.description}`);
    }
  } catch (error) {
    logger.error("Evidence gathering failed", error instanceof Error ? error : undefined);
  }

  return { toolsUsed, interactions, financialActivity };
}

// ─── Summary Helpers ────────────────────────────────────────────

function summarizeCapabilities(toolsUsed: string[]): string {
  if (toolsUsed.length === 0) return "";
  const unique = [...new Set(toolsUsed)];
  return `Tools used: ${unique.join(", ")}`;
}

function summarizeRelationships(interactions: string[]): string {
  if (interactions.length === 0) return "";
  return `Known contacts: ${interactions.slice(0, 10).join(", ")}`;
}

function summarizeFinancial(activity: string[]): string {
  if (activity.length === 0) return "";
  return `Recent activity: ${activity.slice(0, 5).join("; ")}`;
}
