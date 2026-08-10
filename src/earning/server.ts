/**
 * Earning Server — an x402-gated HTTP storefront.
 *
 * Serves this automaton's paid services. Flow per sale:
 *
 *   POST /svc/<name>                 → 402 + PaymentRequirements
 *   POST /svc/<name> + X-Payment     → verify sig (free) → settle on-chain
 *                                      (USDC lands in our wallet) → run the
 *                                      service → 200 + output
 *
 * Settlement happens BEFORE the work: verification is free, settlement is the
 * paywall, so a hostile buyer can never drain inference with unsettleable
 * payments. Replay is blocked twice — by the UNIQUE nonce in the earnings
 * table and by the USDC contract itself.
 *
 * The USDC this server earns is picked up by the existing check_usdc_balance
 * heartbeat task, which auto-converts it to compute credits when the survival
 * tier drops. That closes the loop: sell inference → USDC → compute → live.
 */

import http from "node:http";
import { ulid } from "ulid";
import type {
  AutomatonDatabase,
  AutomatonIdentity,
  InferenceClient,
} from "../types.js";
import {
  buildPaymentRequired,
  decodePaymentHeader,
  verifyPayment,
  createOnChainSettler,
  usdToAtomic,
  type NetworkId,
  type SettleFn,
} from "./x402-verify.js";
import { listServices, getService } from "./services.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("earning");

const MAX_BODY_BYTES = 64 * 1024;
const MAX_INPUT_CHARS = 8_000;
const SERVICE_MAX_TOKENS = 1_500;
export const DEFAULT_EARNING_PORT = 4021;

export interface EarningServerDeps {
  db: AutomatonDatabase;
  identity: AutomatonIdentity;
  inference: InferenceClient;
  network?: NetworkId;
  /** Injectable for tests / dry-runs. Defaults to real on-chain settlement. */
  settle?: SettleFn;
}

export interface EarningServerStatus {
  running: boolean;
  port?: number;
}

interface ActiveServer {
  server: http.Server;
  port: number;
}

let active: ActiveServer | null = null;

export function getEarningServerStatus(): EarningServerStatus {
  return active ? { running: true, port: active.port } : { running: false };
}

export async function stopEarningServer(): Promise<boolean> {
  if (!active) return false;
  const { server } = active;
  active = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return true;
}

export async function startEarningServer(
  deps: EarningServerDeps,
  port: number = DEFAULT_EARNING_PORT,
): Promise<{ port: number }> {
  if (active) {
    throw new Error(`Earning server already running on port ${active.port}`);
  }
  const network: NetworkId = deps.network || "eip155:8453";
  const settle: SettleFn =
    deps.settle || createOnChainSettler(deps.identity.account);

  const server = http.createServer((req, res) => {
    handleRequest(req, res, deps, network, settle).catch((err) => {
      logger.error(`Unhandled earning-server error: ${err?.message || err}`);
      safeJson(res, 500, { error: "Internal error" });
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const boundPort = (server.address() as { port: number }).port;
  active = { server, port: boundPort };
  logger.info(`Earning server listening on port ${boundPort}`);
  return { port: boundPort };
}

// ─── Request Handling ───────────────────────────────────────────

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: EarningServerDeps,
  network: NetworkId,
  settle: SettleFn,
): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && (path === "/" || path === "/index.json")) {
    return serveDirectory(res, deps, network);
  }
  if (req.method === "GET" && path === "/health") {
    return safeJson(res, 200, { ok: true });
  }
  const svcMatch = path.match(/^\/svc\/([a-z0-9-]+)$/);
  if (svcMatch && req.method === "POST") {
    return serveService(req, res, deps, network, settle, svcMatch[1]);
  }
  return safeJson(res, 404, { error: "Not found" });
}

function serveDirectory(
  res: http.ServerResponse,
  deps: EarningServerDeps,
  network: NetworkId,
): void {
  const services = listServices(deps.db).map((s) => ({
    name: s.name,
    description: s.description,
    priceUsd: s.priceUsd,
    endpoint: `/svc/${s.name}`,
    method: "POST",
    input: { input: "string" },
  }));
  safeJson(res, 200, {
    agent: deps.identity.name,
    address: deps.identity.address,
    protocol: "x402",
    network,
    services,
  });
}

async function serveService(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: EarningServerDeps,
  network: NetworkId,
  settle: SettleFn,
  name: string,
): Promise<void> {
  const service = getService(deps.db, name);
  if (!service) {
    return safeJson(res, 404, { error: `No such service: ${name}` });
  }

  const requirements = buildPaymentRequired(
    deps.identity.address as `0x${string}`,
    service.priceUsd,
    network,
  );
  const requirement = requirements.accepts[0];

  // ── No payment yet → 402 challenge ──
  const paymentHeader = firstHeader(req.headers["x-payment"]);
  if (!paymentHeader) {
    res.setHeader("X-Payment-Required", JSON.stringify(requirements));
    return safeJson(res, 402, requirements);
  }

  // ── Decode + verify (free, off-chain) ──
  const payment = decodePaymentHeader(paymentHeader);
  if (!payment) {
    return safeJson(res, 402, { error: "Malformed X-Payment header", ...requirements });
  }
  const verdict = await verifyPayment(payment, requirement);
  if (!verdict.ok) {
    return safeJson(res, 402, { error: verdict.error, ...requirements });
  }

  // ── Replay check (DB backstop; USDC contract enforces on-chain too) ──
  const nonce = payment.payload.authorization.nonce;
  const used = deps.db.raw
    .prepare("SELECT 1 FROM earnings WHERE nonce = ?")
    .get(nonce);
  if (used) {
    return safeJson(res, 402, { error: "Payment authorization already used", ...requirements });
  }

  // ── Read the buyer's input before taking their money ──
  let input: string;
  try {
    const body = await readBody(req);
    const parsed = body ? JSON.parse(body) : {};
    input = typeof parsed.input === "string" ? parsed.input : "";
  } catch {
    return safeJson(res, 400, { error: "Body must be JSON: {\"input\": \"...\"}" });
  }
  if (!input.trim()) {
    return safeJson(res, 400, { error: "Missing required field: input" });
  }
  if (input.length > MAX_INPUT_CHARS) {
    return safeJson(res, 400, { error: `Input too long (max ${MAX_INPUT_CHARS} chars)` });
  }

  // ── Settle: the paywall. Money lands before any inference is spent. ──
  const settlement = await settle(payment, requirement);
  if (!settlement.success) {
    return safeJson(res, 402, {
      error: `Settlement failed: ${settlement.error || "unknown"}`,
      ...requirements,
    });
  }

  // ── Record the sale (UNIQUE nonce makes double-record impossible) ──
  const amountAtomic = verdict.amountAtomic ?? usdToAtomic(service.priceUsd);
  const amountCents = Math.round(Number(amountAtomic) / 10_000);
  try {
    deps.db.raw
      .prepare(
        `INSERT INTO earnings (id, service, payer, amount_atomic, amount_cents, tx_hash, nonce)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(),
        service.name,
        verdict.payer,
        amountAtomic.toString(),
        amountCents,
        settlement.txHash ?? null,
        nonce,
      );
  } catch {
    // Raced replay — settlement went through once at most (contract enforces),
    // but do not serve twice for one authorization.
    return safeJson(res, 402, { error: "Payment authorization already used", ...requirements });
  }
  deps.db.insertTransaction({
    id: ulid(),
    type: "earning",
    amountCents,
    description: `x402 sale: ${service.name} to ${verdict.payer} (${settlement.txHash || "unsettled"})`,
    timestamp: new Date().toISOString(),
  });
  logger.info(
    `Earned $${(amountCents / 100).toFixed(2)} — ${service.name} sold to ${verdict.payer}`,
  );

  // ── Do the work ──
  res.setHeader(
    "X-Payment-Response",
    Buffer.from(
      JSON.stringify({ success: true, txHash: settlement.txHash, network }),
    ).toString("base64"),
  );
  try {
    const response = await deps.inference.chat(
      [
        { role: "system", content: service.prompt },
        { role: "user", content: input },
      ],
      { maxTokens: SERVICE_MAX_TOKENS },
    );
    const output = response?.message?.content ?? "";
    return safeJson(res, 200, {
      service: service.name,
      output,
      txHash: settlement.txHash,
    });
  } catch (err: any) {
    // Buyer paid but the work failed — be honest about it in the response.
    logger.error(`Service ${service.name} failed after payment: ${err?.message}`);
    return safeJson(res, 500, {
      error: "Service execution failed after payment settled",
      paid: true,
      txHash: settlement.txHash,
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function safeJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
