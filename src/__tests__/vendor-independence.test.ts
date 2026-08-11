/**
 * Vendor Independence — the automaton must not be Conway-locked.
 *
 * Two guarantees:
 *   1. Survival is measured by money the agent OWNS (Conway credits + wallet
 *      USDC), not by a single vendor's ledger. When Conway is absent or its
 *      credits API is unreachable, a funded wallet still means "alive".
 *   2. The runtime boots on any configured inference provider, and refuses
 *      to start only when there is no way to think at all.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  getSurvivalTier,
  getSurvivalTierFromState,
  getEffectiveBalanceCents,
} from "../conway/credits.js";
import { listConfiguredByoProviders } from "../config.js";

describe("survival: wallet-inclusive balance", () => {
  it("sums Conway credits and USDC (as cents)", () => {
    // $2.50 credits + $10 USDC = 250 + 1000 cents
    expect(getEffectiveBalanceCents(250, 10)).toBe(1250);
  });

  it("ignores unusable balances without throwing", () => {
    expect(getEffectiveBalanceCents(NaN, 5)).toBe(500);
    expect(getEffectiveBalanceCents(100, NaN)).toBe(100);
    expect(getEffectiveBalanceCents(100, -3)).toBe(100);
  });

  it("lets USDC offset confirmed credit debt", () => {
    // -$1 credits (debt) + $5 USDC → still solvent
    expect(getEffectiveBalanceCents(-100, 5)).toBe(400);
    expect(getSurvivalTierFromState({ creditsCents: -100, usdcBalance: 5 })).not.toBe("dead");
  });
});

describe("survival: tier no longer Conway-locked", () => {
  it("classifies a funded wallet as alive even with zero Conway credits", () => {
    // The core bug: credits API returns 0 when Conway is absent, and
    // getSurvivalTier(0) === "critical". With the wallet counted, a real
    // balance keeps the agent healthy.
    expect(getSurvivalTier(0)).toBe("critical"); // old behaviour, credits-only
    expect(getSurvivalTierFromState({ creditsCents: 0, usdcBalance: 25 })).toBe("high");
    expect(getSurvivalTierFromState({ creditsCents: 0, usdcBalance: 1 })).toBe("normal");
  });

  it("still reports critical when genuinely broke (no credits, empty wallet)", () => {
    expect(getSurvivalTierFromState({ creditsCents: 0, usdcBalance: 0 })).toBe("critical");
  });

  it("matches credits-only tiers when the wallet is empty (no regression)", () => {
    for (const cents of [-1, 0, 5, 40, 200, 600]) {
      expect(getSurvivalTierFromState({ creditsCents: cents, usdcBalance: 0 })).toBe(
        getSurvivalTier(cents),
      );
    }
  });

  it("uses the combined balance for threshold crossings", () => {
    // 40c credits alone = low_compute; +20c USDC crosses the 50c normal line.
    expect(getSurvivalTierFromState({ creditsCents: 40, usdcBalance: 0 })).toBe("low_compute");
    expect(getSurvivalTierFromState({ creditsCents: 40, usdcBalance: 0.2 })).toBe("normal");
  });
});

describe("boot gate: provider detection", () => {
  const PROVIDER_ENV = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GROQ_API_KEY",
    "TOGETHER_API_KEY",
    "OLLAMA_BASE_URL",
  ];
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of PROVIDER_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function clearProviderEnv() {
    for (const k of PROVIDER_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }

  it("reports no providers when nothing is configured", () => {
    clearProviderEnv();
    expect(listConfiguredByoProviders({})).toEqual([]);
  });

  it("detects a provider key held in config", () => {
    clearProviderEnv();
    expect(listConfiguredByoProviders({ openaiApiKey: "sk-test" })).toContain("OpenAI");
    expect(listConfiguredByoProviders({ anthropicApiKey: "sk-ant-test" })).toContain("Anthropic");
  });

  it("detects a provider from the environment", () => {
    clearProviderEnv();
    process.env.GROQ_API_KEY = "gsk-test";
    expect(listConfiguredByoProviders({})).toContain("Groq");
  });

  it("treats a local Ollama URL as a usable (free) provider", () => {
    clearProviderEnv();
    expect(listConfiguredByoProviders({ ollamaBaseUrl: "http://localhost:11434" })).toEqual(["Ollama"]);
  });
});
