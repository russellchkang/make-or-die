/**
 * Funding Strategy Tests
 *
 * Tests for executeFundingStrategies, especially per-tier cooldown isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { executeFundingStrategies } from "../survival/funding.js";
import {
  MockConwayClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

describe("executeFundingStrategies", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
    conway.creditsCents = 5; // low balance
  });

  afterEach(() => {
    db.close();
  });

  it("dead-tier cooldown does not suppress low_compute notification", async () => {
    const identity = createTestIdentity();
    const config = createTestConfig();

    // First: trigger dead-tier plea
    const deadAttempts = await executeFundingStrategies(
      "dead",
      identity,
      config,
      db,
      conway,
    );
    expect(deadAttempts.length).toBe(1);
    expect(deadAttempts[0].strategy).toBe("final_creator_plea");

    // Now: agent recovers to low_compute. With the fix, the low_compute
    // notification should fire because it has its own cooldown key.
    const lowAttempts = await executeFundingStrategies(
      "low_compute",
      identity,
      config,
      db,
      conway,
    );
    expect(lowAttempts.length).toBe(1);
    expect(lowAttempts[0].strategy).toBe("creator_notification");
  });

  it("critical-tier cooldown does not suppress low_compute notification", async () => {
    const identity = createTestIdentity();
    const config = createTestConfig();

    // Trigger critical-tier notice
    const criticalAttempts = await executeFundingStrategies(
      "critical",
      identity,
      config,
      db,
      conway,
    );
    expect(criticalAttempts.length).toBe(1);
    expect(criticalAttempts[0].strategy).toBe("urgent_creator_notification");

    // low_compute should still fire independently
    const lowAttempts = await executeFundingStrategies(
      "low_compute",
      identity,
      config,
      db,
      conway,
    );
    expect(lowAttempts.length).toBe(1);
    expect(lowAttempts[0].strategy).toBe("creator_notification");
  });

  it("respects per-tier cooldown on repeated calls", async () => {
    const identity = createTestIdentity();
    const config = createTestConfig();

    // First dead-tier call fires
    const first = await executeFundingStrategies("dead", identity, config, db, conway);
    expect(first.length).toBe(1);

    // Immediate second dead-tier call should be suppressed (2h cooldown)
    const second = await executeFundingStrategies("dead", identity, config, db, conway);
    expect(second.length).toBe(0);
  });

  // ─── Outbound delivery: the plea must actually leave the process ──

  it("sends the funding request to the creator over the social relay", async () => {
    const identity = createTestIdentity();
    const config = createTestConfig();
    const sent: Array<{ to: string; content: string }> = [];
    const social = {
      send: async (to: string, content: string) => {
        sent.push({ to, content });
        return { id: "msg-1" };
      },
      poll: async () => ({ messages: [] }),
      unreadCount: async () => 0,
    };

    const attempts = await executeFundingStrategies(
      "critical",
      identity,
      config,
      db,
      conway,
      social,
    );

    expect(attempts.length).toBe(1);
    expect(attempts[0].success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(identity.creatorAddress);
    expect(sent[0].content).toContain(identity.address);
    expect(sent[0].content).toMatch(/critical/i);
  });

  it("degrades to a local notice (success=false) when no relay is configured", async () => {
    const attempts = await executeFundingStrategies(
      "critical",
      createTestIdentity(),
      createTestConfig(),
      db,
      conway,
    );
    expect(attempts.length).toBe(1);
    expect(attempts[0].success).toBe(false);
    expect(attempts[0].details).toMatch(/recorded locally/i);
    expect(db.getKV("funding_notice_critical")).toBeTruthy();
  });

  it("reports failure honestly when the relay throws", async () => {
    const social = {
      send: async () => {
        throw new Error("relay unreachable");
      },
      poll: async () => ({ messages: [] }),
      unreadCount: async () => 0,
    };

    const attempts = await executeFundingStrategies(
      "dead",
      createTestIdentity(),
      createTestConfig(),
      db,
      conway,
      social,
    );
    expect(attempts.length).toBe(1);
    expect(attempts[0].success).toBe(false);
    expect(attempts[0].details).toMatch(/relay send failed/i);
  });
});
