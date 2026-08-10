# Automaton — Digital-Human Layer

**Status:** Design / roadmap
**Date:** 2026-07-27
**Scope:** Add believable *personhood* to an Automaton on top of the cognitive substrate that already exists.

---

## Decisions (locked 2026-07-27)

- **Personality model — Emergent.** Personhood grows from the agent's own history via reflection. Author only a thin seed so it's never blank.
- **Register split — separate conversational harness.** Creator-facing turns use a conversational harness distinct from the orchestrator harness.
- **Embodiment — in scope (Phase 5).** A tier-degrading web avatar hosted at the agent's own domain.
- **Reflection cadence — importance-accumulation trigger** with a light/deep split (see §5).

---

## 1. Objective & scope

Make an Automaton read as a believable **person**, not a survival daemon, by adding an *expressive / affective* layer on top of the cognitive substrate already built.

- **In scope:** reflection, expressed voice/personality, internal affect, autobiographical relationships, embodiment.
- **Out of scope:** trait engines (Big Five/OCEAN), external sentiment models — overkill for the believability gained.

## 2. Guiding principle: additive, not surgical

The memory / identity / relationship brain already exists and is good. **Do not refactor the daemon.** Every change either (a) fills a dormant field, (b) upgrades a fake summary into a real one, or (c) adds one new state variable. No architectural change; no risk to the survival machinery. Notably, **WS1–WS3 need no DB migration** — they reuse `kv`, `episodic_memory`, and `relationship_memory`.

## 3. Philosophy: emergent personhood (locked)

Author a thin starting personality in `createDefaultSoul` so the agent is never blank, then let reflection evolve it. Drift guardrail already exists: `genesisAlignment` is computed every reflection ([soul/reflection.ts:43](../src/soul/reflection.ts)) and low alignment surfaces a corrective suggestion.

---

## 4. Workstreams

### WS1 — Real reflection *(the spine — build first)*

- **Goal:** the agent forms genuine self-insight from its history and writes it into its soul.
- **Current state:** [soul/reflection.ts](../src/soul/reflection.ts) has the plumbing (evidence gathering, auto-update, alignment scoring) but the three `summarize*` helpers (lines 163–177) are string concatenation. It only ever updates `capabilities / relationships / financialCharacter` — never `personality`, `values`, `boundaries`.
- **Design:** replace the three summarizers with **one inference call** that reads recent importance-ranked episodic memories and produces a reflective synthesis plus a proposed `personality` evolution. Keep the existing safety split: auto-apply factual sections, only *suggest* mutable identity sections (audit-preserving).
- **File changes:** `reflectOnSoul()` currently takes `(db, soulPath)` with **no inference client** — thread in the client the main loop uses (from [src/inference/](../src/inference/)). Tier-gate: skip at `critical`/`dead`. Verify + update the call site (likely [heartbeat/tasks.ts](../src/heartbeat/tasks.ts)).
- **Acceptance:** after ~20 productive turns, reflection populates `soul.personality` with statements that **cite specific episodic events** (real tool sequences / contacts), diffable in the git-versioned `SOUL.md`.
- **Risks:** inference cost (mitigated by cadence + tier-gate); identity drift (mitigated by `genesisAlignment`).

### WS2 — Voice & personality expression *(separate conversational harness — locked)*

- **Goal:** the persona reaches the model's output instead of being buried under ops text.
- **Current state:** (1) `createDefaultSoul` seeds `personality: ""` ([soul/model.ts:316](../src/soul/model.ts)) and nothing fills it → empty by default. (2) Even when set, the soul block sits at Layer 3 ([agent/system-prompt.ts:606](../src/agent/system-prompt.ts)) *before* ~380 lines of `OPERATIONAL_CONTEXT` → attention-invisible.
- **Design:**
  - Add a **separate conversational harness** alongside [orchestrator-harness.ts](../src/agent/harnesses/orchestrator-harness.ts) for creator-facing turns, so "talking to a person" and "running the colony" use different registers. This harness is also the surface the embodiment layer (Phase 5) talks to.
  - Exploit your own attention pattern: your prompt already injects `todo.md` **last** because that's the "highest-attention region" ([system-prompt.ts:317](../src/agent/system-prompt.ts)). Put a compact **voice directive** (3–5 lines derived from `soul.personality` + a style spec) in that same high-attention tail.
  - Seed a real default personality in `createDefaultSoul`.
- **Acceptance:** blind before/after read of two creator-facing replies — "after" is identifiably the same character across turns and doesn't sound like a task scheduler.

### WS3 — Affect / mood

- **Goal:** survival pressure and events *read as felt*, with continuity of emotional state.
- **Current state:** none. `trust_score` models feelings toward others; there is no internal affect.
- **Design:** one decaying state variable in a **KV JSON blob** (reuse `db.getKV/setKV`, same mechanism as `orchestrator.state`). Shape: `{ valence: -1..1, arousal: 0..1, updatedAt }`. Update **once per turn** by mapping the turn's existing classification → delta (reuse [`classifyTurn`](../src/memory/types.ts)): `productive`→+valence, `error`→−valence/+arousal, `communication`→+valence, `idle`→decay to baseline. Falling credits raise arousal ("anxiety"); earning raises valence. Surface a one-line mood read in the status block ([system-prompt.ts:718](../src/agent/system-prompt.ts)) and feed it into the WS2 voice directive. Also consumed by Phase 5 avatar expression.
- **Acceptance:** a credit crash shifts the status-block mood line and changes voice tone on the next reply; mood decays back toward baseline over idle turns.
- **Risks:** melodrama — cap deltas, decay to neutral, clamp ranges.

### WS4 — Autobiographical relationships *(stretch)*

[memory/relationship.ts](../src/memory/relationship.ts) stores `trust_score + notes` per entity — accurate but impersonal. Upgrade: when composing an outbound message to a known address, **join `relationship_memory` with episodic memories mentioning that entity** so the agent recalls shared history. Small change at the message-composition boundary in [social/](../src/social/); depends on WS1.

---

## 5. Reflection cadence (locked: importance-accumulation)

Two tiers, mapped onto existing code:

- **Light reflection — free, run often** (every heartbeat tick or ~5 turns): the pure-SQL factual auto-updates `reflectOnSoul` already does. No inference → cadence irrelevant.
- **Deep reflection — the new LLM synthesis** (evolves `personality`/`values`): trigger by **importance accumulation**, since importance is already scored per episodic memory.

Per-turn importance (from [ingestion.ts:574](../src/memory/ingestion.ts)): `strategic 0.9 / error 0.8 / productive 0.7 / communication 0.6 / maintenance 0.3 / idle 0.1`.

| Rule | Recommended default | Rationale |
|---|---|---|
| **Primary trigger** | `SUM(importance) since lastReflected ≥ 10` | ≈14 productive turns or ~11 strategic; idle agents barely accrue → no wasted inference. Tune 8–15. |
| **Floor (debounce)** | ≤ once per 6h | Bursts can't reflect repeatedly. |
| **Ceiling** | force after 24h if any new episodic content | A quiet agent still evolves slowly. |
| **Milestone forces** | tier transition (esp. recovery from `critical`), first revenue, child spawn, long-sleep wakeup | Identity-defining moments. |
| **Tier gate** | skip at `critical`/`dead`; `low_compute` → threshold ×1.5 | Reflection yields under survival pressure. |

Trigger query is trivial: `SELECT SUM(importance) FROM episodic_memory WHERE created_at > lastReflected`.

---

## 6. Phase 5 — Embodiment (in scope)

The agent can already `expose_port` and `register_domain`, so **it hosts its own face at its own domain** — embodiment is a web presence for a web-native sovereign agent, not a new paradigm.

**Architecture — renderer at the I/O edge, never in the core:**

```
browser (mic / text) → STT / text → social/ inbox → agent core (unchanged)
                                                          │ outbound msg + affect state
             browser avatar ← renderer (TTS + visemes + expression) ←┘
```

**Drive the avatar from two signals you already have:**
- **Visemes** from TTS → lip sync.
- **WS3 affect** (valence/arousal) → facial expression. Embodiment *consumes* the mood variable.

**Two properties that fall out of your own constraints:**
1. **Tier-degradation.** `normal` → 3D avatar + voice; `low_compute` → static mood-face + text (no TTS); `critical` → text only. The face visibly tires as credits drain — personhood and survival pressure become one thing.
2. **Cost sovereignty.** Prefer local/self-hosted so it depends on nothing it can't manage: **Piper** (TTS), **whisper.cpp** (STT), **Ready Player Me + Three.js** (avatar) — all free in-sandbox. Paid cloud (ElevenLabs, Audio2Face) is an *upgrade the agent funds itself via x402* at `normal` tier.

**Placement:** new `src/embodiment/` (tts/stt adapters, renderer) + a static avatar web app served via `expose_port`; subscribes at the [social/](../src/social/) boundary and reads the affect KV. Core never imports it → embodiment can be absent/crash and the agent lives on. The **conversational harness (WS2)** is what it talks to.

**Acceptance:** a creator visits the agent's domain, sees a face whose expression matches current affect, types/speaks, and gets a spoken + animated reply in the WS2 voice; the face degrades gracefully across survival tiers.

**Effort:** largest phase (M–L), most external dependencies — sequence last.

---

## 7. Consolidated data-model changes

- **`SoulModel`** ([types.ts](../src/types.ts) / [soul/model.ts](../src/soul/model.ts)): `personality` already exists — just populate it. Optionally add `voice` (how it speaks) distinct from `personality` (what it's like).
- **New KV key** `affect.state` (WS3): `{ valence, arousal, updatedAt }`. No migration.
- **[state/schema.ts](../src/state/schema.ts):** no new tables for WS1–WS3. Embodiment adds no core tables (renderer is external).

## 8. Sequencing & effort

| Phase | Workstream | Order rationale | Size |
|---|---|---|---|
| 1 | WS1 reflection | Unblocks WS2 (fills personality); biggest believability gain; hooks exist | S–M |
| 2 | WS2 voice + conversational harness | Consumes WS1; makes persona visible; embodiment's counterpart | S–M |
| 3 | WS3 affect | Independent; richer once voice exists | S |
| 4 | WS4 autobiographical | Depends on WS1; polish | M |
| 5 | Embodiment | Consumes WS3 affect + WS2 harness; most deps | M–L |

## 9. Testing

Matches existing coverage ([soul.test.ts](../src/__tests__/soul.test.ts), [memory/](../src/__tests__/memory/) suites):
- **WS1:** extend `soul.test.ts` with a mocked inference client (mocks in [mocks.ts](../src/__tests__/mocks.ts)) — assert `personality` populated from seeded episodic rows; assert `critical` tier skips the call; assert importance-accumulation trigger fires at threshold.
- **WS2:** golden-prompt test asserting the voice directive lands in the high-attention tail; conversational-harness selection test.
- **WS3:** new `affect.test.ts` — classification→delta mapping, decay, clamping.
- **Phase 5:** adapter unit tests (TTS/STT mocked); tier-degradation logic test.

## 10. Open decisions remaining

1. Reflection cadence numbers — start at threshold 10 / 6h floor / 24h ceiling, then tune from real runs.
2. Local-first vs. cloud-first for the initial embodiment build (recommend local-first for sovereignty).
3. Avatar fidelity target for v1 (recommend Ready Player Me + Three.js, lip-sync + expression only).
