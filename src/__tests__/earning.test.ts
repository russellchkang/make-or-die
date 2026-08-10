/**
 * Earning — x402 storefront tests.
 *
 * Runs the FULL buyer→seller loop over real HTTP: a buyer wallet signs a
 * genuine EIP-3009 TransferWithAuthorization (exactly as the client in
 * src/conway/x402.ts does), the earning server verifies the signature,
 * "settles" via an injected settler, serves the paid service, and records
 * revenue. Only the chain is mocked — the wire format is the real thing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseUnits, type Address, type PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createDatabase } from "../state/database.js";
import type { AutomatonDatabase, AutomatonIdentity, InferenceClient } from "../types.js";
import {
  startEarningServer,
  stopEarningServer,
  getEarningServerStatus,
} from "../earning/server.js";
import { saveService, listServices, removeService } from "../earning/services.js";
import {
  buildPaymentRequired,
  decodePaymentHeader,
  verifyPayment,
  type SettleFn,
} from "../earning/x402-verify.js";

// ─── Buyer-side signing (mirrors signPayment in src/conway/x402.ts) ──

const NETWORK = "eip155:8453" as const;
const CHAIN_ID = 8453;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

interface SignOverrides {
  to?: Address;
  valueUsd?: string;
  validBefore?: number;
  signer?: PrivateKeyAccount;
  nonce?: `0x${string}`;
}

async function signPaymentHeader(
  buyer: PrivateKeyAccount,
  payTo: Address,
  amountUsd: string,
  overrides: SignOverrides = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const nonce =
    overrides.nonce ??
    (`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as `0x${string}`);
  const value = parseUnits(overrides.valueUsd ?? amountUsd, 6);
  const to = overrides.to ?? payTo;
  const validAfter = now - 60;
  const validBefore = overrides.validBefore ?? now + 300;
  const signer = overrides.signer ?? buyer;

  const signature = await signer.signTypedData({
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: CHAIN_ID,
      verifyingContract: USDC,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: buyer.address,
      to,
      value,
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network: NETWORK,
      payload: {
        signature,
        authorization: {
          from: buyer.address,
          to,
          value: value.toString(),
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          nonce,
        },
      },
    }),
  ).toString("base64");
}

// ─── Fixture ────────────────────────────────────────────────────

describe("earning: x402 storefront", () => {
  let tmpDir: string;
  let db: AutomatonDatabase;
  let seller: PrivateKeyAccount;
  let buyer: PrivateKeyAccount;
  let identity: AutomatonIdentity;
  let inference: InferenceClient;
  let settle: ReturnType<typeof vi.fn>;
  let baseUrl: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-earning-test-"));
    db = createDatabase(path.join(tmpDir, "state.db"));
    seller = privateKeyToAccount(generatePrivateKey());
    buyer = privateKeyToAccount(generatePrivateKey());
    identity = {
      name: "test-automaton",
      address: seller.address,
      account: seller,
      creatorAddress: "0x0000000000000000000000000000000000000001",
      sandboxId: "sbx-test",
      apiKey: "test-key",
      createdAt: new Date().toISOString(),
    };
    inference = {
      chat: vi.fn(async () => ({
        message: { role: "assistant" as const, content: "the answer is 42" },
      })) as any,
      setLowComputeMode: () => {},
      getDefaultModel: () => "test-model",
    } as unknown as InferenceClient;
    settle = vi.fn(async () => ({ success: true, txHash: "0xmocktx" }));

    saveService(db, {
      name: "oracle",
      description: "Answers one question",
      priceUsd: 0.05,
      prompt: "You are a paid oracle. Answer concisely.",
    });

    const { port } = await startEarningServer(
      { db, identity, inference, network: NETWORK, settle: settle as unknown as SettleFn },
      0, // ephemeral port
    );
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await stopEarningServer();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function buy(header?: string, body?: unknown): Promise<Response> {
    return fetch(`${baseUrl}/svc/oracle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(header ? { "X-Payment": header } : {}),
      },
      body: JSON.stringify(body ?? { input: "What is the answer?" }),
    });
  }

  // ─── Directory & challenge ──

  it("serves a public directory of paid services", async () => {
    const resp = await fetch(`${baseUrl}/`);
    expect(resp.status).toBe(200);
    const dir = await resp.json();
    expect(dir.address).toBe(seller.address);
    expect(dir.protocol).toBe("x402");
    expect(dir.services).toHaveLength(1);
    expect(dir.services[0]).toMatchObject({
      name: "oracle",
      priceUsd: 0.05,
      endpoint: "/svc/oracle",
    });
  });

  it("responds 402 with client-parseable requirements when unpaid", async () => {
    const resp = await buy();
    expect(resp.status).toBe(402);
    expect(resp.headers.get("x-payment-required")).toBeTruthy();
    const body = await resp.json();
    expect(body.x402Version).toBe(1);
    const req = body.accepts[0];
    // Field names the client's normalizePaymentRequirement expects:
    expect(req.scheme).toBe("exact");
    expect(req.network).toBe(NETWORK);
    expect(req.payToAddress).toBe(seller.address);
    expect(req.maxAmountRequired).toBe("0.05");
    // Decimal-dollar form parses to the right atomic amount client-side.
    expect(parseUnits(req.maxAmountRequired, 6)).toBe(50000n);
  });

  // ─── The full happy path ──

  it("verifies, settles, serves, and records a real signed payment", async () => {
    const header = await signPaymentHeader(buyer, seller.address, "0.05");
    const resp = await buy(header);

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.output).toBe("the answer is 42");
    expect(body.txHash).toBe("0xmocktx");
    expect(settle).toHaveBeenCalledTimes(1);

    // Receipt header for the buyer
    const receipt = JSON.parse(
      Buffer.from(resp.headers.get("x-payment-response")!, "base64").toString(),
    );
    expect(receipt.success).toBe(true);

    // Revenue recorded: earnings row + transaction ledger entry
    const earning = db.raw
      .prepare("SELECT * FROM earnings")
      .get() as Record<string, unknown>;
    expect(earning.service).toBe("oracle");
    expect(earning.payer).toBe(buyer.address);
    expect(earning.amount_cents).toBe(5);
    expect(earning.tx_hash).toBe("0xmocktx");

    const txns = db.getRecentTransactions(5);
    expect(txns.some((t) => t.type === "earning" && t.amountCents === 5)).toBe(true);

    // The service actually ran with the buyer's input
    expect(inference.chat).toHaveBeenCalledWith(
      [
        { role: "system", content: "You are a paid oracle. Answer concisely." },
        { role: "user", content: "What is the answer?" },
      ],
      expect.objectContaining({ maxTokens: expect.any(Number) }),
    );
  });

  it("accepts overpayment (value above price)", async () => {
    const header = await signPaymentHeader(buyer, seller.address, "0.05", {
      valueUsd: "1.00",
    });
    const resp = await buy(header);
    expect(resp.status).toBe(200);
    const earning = db.raw
      .prepare("SELECT amount_cents FROM earnings")
      .get() as { amount_cents: number };
    expect(earning.amount_cents).toBe(100);
  });

  // ─── Attacks & failures ──

  it("rejects a replayed payment authorization", async () => {
    const header = await signPaymentHeader(buyer, seller.address, "0.05");
    const first = await buy(header);
    expect(first.status).toBe(200);

    const replay = await buy(header);
    expect(replay.status).toBe(402);
    const body = await replay.json();
    expect(body.error).toMatch(/already used/i);
    expect(settle).toHaveBeenCalledTimes(1); // never settled twice
  });

  it("rejects payment addressed to someone else", async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const header = await signPaymentHeader(buyer, seller.address, "0.05", {
      to: other.address,
    });
    const resp = await buy(header);
    expect(resp.status).toBe(402);
    expect((await resp.json()).error).toMatch(/not this automaton/i);
    expect(settle).not.toHaveBeenCalled();
  });

  it("rejects underpayment", async () => {
    const header = await signPaymentHeader(buyer, seller.address, "0.05", {
      valueUsd: "0.01",
    });
    const resp = await buy(header);
    expect(resp.status).toBe(402);
    expect((await resp.json()).error).toMatch(/underpayment/i);
    expect(settle).not.toHaveBeenCalled();
  });

  it("rejects an expired authorization", async () => {
    const header = await signPaymentHeader(buyer, seller.address, "0.05", {
      validBefore: Math.floor(Date.now() / 1000) - 10,
    });
    const resp = await buy(header);
    expect(resp.status).toBe(402);
    expect((await resp.json()).error).toMatch(/expired/i);
    expect(settle).not.toHaveBeenCalled();
  });

  it("rejects a signature that does not match the payer", async () => {
    const mallory = privateKeyToAccount(generatePrivateKey());
    const header = await signPaymentHeader(buyer, seller.address, "0.05", {
      signer: mallory, // signs for buyer's address with the wrong key
    });
    const resp = await buy(header);
    expect(resp.status).toBe(402);
    expect((await resp.json()).error).toMatch(/signature/i);
    expect(settle).not.toHaveBeenCalled();
  });

  it("rejects garbage payment headers without settling", async () => {
    const resp = await buy(Buffer.from("not json").toString("base64"));
    expect(resp.status).toBe(402);
    expect((await resp.json()).error).toMatch(/malformed/i);
    expect(settle).not.toHaveBeenCalled();
  });

  it("does not settle when the buyer sends no usable input", async () => {
    const header = await signPaymentHeader(buyer, seller.address, "0.05");
    const resp = await buy(header, { input: "" });
    expect(resp.status).toBe(400);
    expect(settle).not.toHaveBeenCalled(); // input checked BEFORE taking money
  });

  it("refuses settlement failures without recording revenue", async () => {
    settle.mockResolvedValueOnce({ success: false, error: "nonce already used on-chain" });
    const header = await signPaymentHeader(buyer, seller.address, "0.05");
    const resp = await buy(header);
    expect(resp.status).toBe(402);
    const rows = db.raw.prepare("SELECT COUNT(*) AS n FROM earnings").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("404s unknown services", async () => {
    const resp = await fetch(`${baseUrl}/svc/nonexistent`, {
      method: "POST",
      body: JSON.stringify({ input: "hi" }),
    });
    expect(resp.status).toBe(404);
  });

  // ─── Service registry ──

  it("validates service definitions", () => {
    expect(saveService(db, { name: "BAD NAME", description: "x", priceUsd: 1, prompt: "p" })).toMatch(/invalid service name/i);
    expect(saveService(db, { name: "free", description: "x", priceUsd: 0, prompt: "p" })).toMatch(/price/i);
    expect(saveService(db, { name: "ok-svc", description: "", priceUsd: 1, prompt: "p" })).toMatch(/description/i);
    expect(saveService(db, { name: "ok-svc", description: "x", priceUsd: 1, prompt: "" })).toMatch(/prompt/i);
    expect(saveService(db, { name: "ok-svc", description: "x", priceUsd: 1, prompt: "p" })).toBeNull();
    expect(listServices(db).map((s) => s.name)).toContain("ok-svc");
    expect(removeService(db, "ok-svc")).toBe(true);
    expect(removeService(db, "ok-svc")).toBe(false);
  });

  it("tracks server lifecycle", async () => {
    expect(getEarningServerStatus().running).toBe(true);
    await stopEarningServer();
    expect(getEarningServerStatus().running).toBe(false);
    // afterEach stop is a no-op then
  });

  // ─── Pricing guard: the agent cannot unknowingly sell at a loss ──

  describe("pricing economics", () => {
    async function runCreateTool(priceUsd: number, model = "gpt-5.2") {
      const { createEarningTools } = await import("../earning/tools.js");
      const tool = createEarningTools().find((t) => t.name === "create_paid_service")!;
      const ctx = {
        db,
        identity,
        inference: { ...inference, getDefaultModel: () => model },
        config: {} as any,
        conway: {} as any,
      } as any;
      return tool.execute(
        {
          name: "priced-svc",
          description: "test service",
          price_usd: priceUsd,
          prompt: "You are a helpful analyst.",
        },
        ctx,
      );
    }

    it("refuses a price below inference cost on an expensive model", async () => {
      // gpt-5.2 output: 140 hundredths-cent/1k × 1.5k tokens ≈ 2.1¢/call → 3x floor ≈ 6.5¢
      const result = await runCreateTool(0.02, "gpt-5.2");
      expect(result).toMatch(/REFUSED/);
      expect(result).toMatch(/lose money/i);
      expect(result).toMatch(/Suggested price/);
      // Nothing was saved
      expect(listServices(db).map((s) => s.name)).not.toContain("priced-svc");
    });

    it("accepts a profitable price and reports the margin", async () => {
      const result = await runCreateTool(0.25, "gpt-5.2");
      expect(result).toMatch(/saved at \$0\.25\/call/);
      expect(result).toMatch(/margin/i);
      expect(listServices(db).map((s) => s.name)).toContain("priced-svc");
    });

    it("assumes worst-case rates for unknown models", async () => {
      const { estimateServiceCost } = await import("../earning/pricing.js");
      const unknown = estimateServiceCost(db, "mystery-model-9000", "prompt");
      const known = estimateServiceCost(db, "gpt-4.1-nano", "prompt");
      expect(unknown.known).toBe(false);
      expect(known.known).toBe(true);
      // Unknown must never be cheaper than a real cheap model
      expect(unknown.floorUsd).toBeGreaterThan(known.floorUsd);
    });

    it("cheap models still clear the guard at the 1-cent minimum", async () => {
      const result = await runCreateTool(0.01, "gpt-4.1-nano");
      expect(result).toMatch(/saved at \$0\.01\/call/);
    });
  });

  // ─── Unit: requirement building round-trips through verifyPayment ──

  it("round-trips its own requirements through verification", async () => {
    const requirements = buildPaymentRequired(seller.address, 0.05, NETWORK);
    const header = await signPaymentHeader(buyer, seller.address, "0.05");
    const payment = decodePaymentHeader(header)!;
    expect(payment).not.toBeNull();
    const verdict = await verifyPayment(payment, requirements.accepts[0]);
    expect(verdict.ok).toBe(true);
    expect(verdict.payer).toBe(buyer.address);
    expect(verdict.amountAtomic).toBe(50000n);
  });
});
