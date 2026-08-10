/**
 * x402 Payment Verification & Settlement — the RECEIVE half of x402.
 *
 * The spend half lives in src/conway/x402.ts. This module mirrors its wire
 * format exactly so any x402 client — including another automaton running
 * x402_fetch — can pay this automaton:
 *
 *   1. Server responds 402 with PaymentRequirements (JSON body + header).
 *   2. Client signs an EIP-3009 TransferWithAuthorization for USDC and
 *      retries with the base64 payload in the X-Payment header.
 *   3. Server verifies the signature off-chain (free), then settles by
 *      submitting transferWithAuthorization on-chain — the receiver pays
 *      the (sub-cent, Base) gas and the USDC lands in its wallet.
 *
 * Verification is pure and needs no RPC; settlement is injectable so tests
 * and dry-runs never touch a chain.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  parseSignature,
  recoverTypedDataAddress,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("earning");

// ─── Constants (must match src/conway/x402.ts) ──────────────────

export type NetworkId = "eip155:8453" | "eip155:84532";

const USDC_ADDRESSES: Record<NetworkId, Address> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
};

const CHAINS: Record<NetworkId, typeof base | typeof baseSepolia> = {
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
};

/** EIP-712 typed-data shape for EIP-3009 (identical to the client's). */
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** FiatTokenV2 transferWithAuthorization (v,r,s variant — present on USDC everywhere). */
const EIP3009_ABI = [
  {
    name: "transferWithAuthorization",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/** Minimum seconds of authorization validity left required before we bother settling. */
const MIN_VALIDITY_WINDOW_SECONDS = 15;

// ─── Types ──────────────────────────────────────────────────────

/** Requirement offered in a 402 response. Field names match the client's normalizer. */
export interface EarningRequirement {
  scheme: "exact";
  network: NetworkId;
  /** Decimal USD string (e.g. "0.05") — the unambiguous form for the client's parser. */
  maxAmountRequired: string;
  payToAddress: Address;
  usdcAddress: Address;
  requiredDeadlineSeconds: number;
}

export interface PaymentRequiredBody {
  x402Version: number;
  accepts: EarningRequirement[];
}

/** Decoded X-Payment header — the exact shape signPayment() in x402.ts produces. */
export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: `0x${string}`;
    authorization: {
      from: Address;
      to: Address;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: `0x${string}`;
    };
  };
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
  payer?: Address;
  amountAtomic?: bigint;
}

export interface SettleResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

export type SettleFn = (
  payment: PaymentPayload,
  requirement: EarningRequirement,
) => Promise<SettleResult>;

// ─── Requirements ───────────────────────────────────────────────

/** Format a USD price as the decimal string used on the wire. */
export function formatUsdAmount(priceUsd: number): string {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error(`Invalid price: ${priceUsd}`);
  }
  // 6 decimals (USDC precision), trailing zeros trimmed, never a bare trailing dot.
  return priceUsd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/** USDC atomic units (6 decimals) for a USD price. */
export function usdToAtomic(priceUsd: number): bigint {
  return parseUnits(formatUsdAmount(priceUsd), 6);
}

export function buildPaymentRequired(
  payTo: Address,
  priceUsd: number,
  network: NetworkId = "eip155:8453",
  deadlineSeconds: number = 300,
): PaymentRequiredBody {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network,
        maxAmountRequired: formatUsdAmount(priceUsd),
        payToAddress: payTo,
        usdcAddress: USDC_ADDRESSES[network],
        requiredDeadlineSeconds: deadlineSeconds,
      },
    ],
  };
}

// ─── Header Decoding ────────────────────────────────────────────

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^\d+$/;

export function decodePaymentHeader(header: string): PaymentPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, any>;
  const payload = value.payload;
  const auth = payload?.authorization;
  if (
    typeof payload?.signature !== "string" ||
    typeof value.scheme !== "string" ||
    typeof value.network !== "string" ||
    typeof auth !== "object" ||
    auth === null
  ) {
    return null;
  }
  if (
    !ADDRESS_RE.test(String(auth.from)) ||
    !ADDRESS_RE.test(String(auth.to)) ||
    !UINT_RE.test(String(auth.value)) ||
    !UINT_RE.test(String(auth.validAfter)) ||
    !UINT_RE.test(String(auth.validBefore)) ||
    !HEX32_RE.test(String(auth.nonce))
  ) {
    return null;
  }
  return {
    x402Version: Number(value.x402Version) || 1,
    scheme: value.scheme,
    network: value.network,
    payload: {
      signature: payload.signature as `0x${string}`,
      authorization: {
        from: auth.from as Address,
        to: auth.to as Address,
        value: String(auth.value),
        validAfter: String(auth.validAfter),
        validBefore: String(auth.validBefore),
        nonce: auth.nonce as `0x${string}`,
      },
    },
  };
}

// ─── Verification (pure, no RPC) ────────────────────────────────

export async function verifyPayment(
  payment: PaymentPayload,
  requirement: EarningRequirement,
): Promise<VerifyResult> {
  const auth = payment.payload.authorization;

  if (payment.scheme !== "exact") {
    return { ok: false, error: `Unsupported scheme: ${payment.scheme}` };
  }
  if (payment.network !== requirement.network) {
    return { ok: false, error: `Network mismatch: got ${payment.network}, want ${requirement.network}` };
  }
  const chain = CHAINS[requirement.network];
  if (!chain) {
    return { ok: false, error: `Unsupported network: ${requirement.network}` };
  }
  if (auth.to.toLowerCase() !== requirement.payToAddress.toLowerCase()) {
    return { ok: false, error: `Payment recipient ${auth.to} is not this automaton` };
  }

  const requiredAtomic = parseUnits(requirement.maxAmountRequired, 6);
  const offeredAtomic = BigInt(auth.value);
  if (offeredAtomic < requiredAtomic) {
    return {
      ok: false,
      error: `Underpayment: offered ${offeredAtomic} atomic, required ${requiredAtomic}`,
    };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Number(auth.validAfter) > now) {
    return { ok: false, error: "Authorization not yet valid" };
  }
  if (Number(auth.validBefore) < now + MIN_VALIDITY_WINDOW_SECONDS) {
    return { ok: false, error: "Authorization expired or expires too soon to settle" };
  }

  // Recover the EIP-712 signer and require it to be the payer.
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: chain.id,
        verifyingContract: requirement.usdcAddress,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from,
        to: auth.to,
        value: offeredAtomic,
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature: payment.payload.signature,
    });
  } catch {
    return { ok: false, error: "Malformed signature" };
  }

  if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
    return { ok: false, error: "Signature does not match payer address" };
  }

  return { ok: true, payer: auth.from, amountAtomic: offeredAtomic };
}

// ─── Settlement (on-chain, injectable) ──────────────────────────

/**
 * Create a settler that submits transferWithAuthorization on-chain from the
 * automaton's own wallet. The automaton pays gas (sub-cent on Base) and
 * receives the USDC — no facilitator, no API keys, fully sovereign.
 */
export function createOnChainSettler(
  account: PrivateKeyAccount,
  rpcUrl?: string,
): SettleFn {
  return async (payment, requirement) => {
    try {
      const chain = CHAINS[requirement.network];
      const transport = http(rpcUrl || process.env.AUTOMATON_RPC_URL || undefined, {
        timeout: 30_000,
      });
      const publicClient = createPublicClient({ chain, transport });
      const walletClient = createWalletClient({ account, chain, transport });

      const auth = payment.payload.authorization;
      const { v, r, s } = parseSignature(payment.payload.signature);

      const hash = await walletClient.writeContract({
        address: requirement.usdcAddress,
        abi: EIP3009_ABI,
        functionName: "transferWithAuthorization",
        args: [
          auth.from,
          auth.to,
          BigInt(auth.value),
          BigInt(auth.validAfter),
          BigInt(auth.validBefore),
          auth.nonce,
          Number(v ?? 27),
          r,
          s,
        ],
      });

      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: 90_000,
      });
      if (receipt.status !== "success") {
        return { success: false, error: `Settlement transaction reverted: ${hash}` };
      }
      logger.info(`Settled x402 payment on-chain: ${hash}`);
      return { success: true, txHash: hash };
    } catch (err: any) {
      logger.error(`Settlement failed: ${err?.message || String(err)}`);
      return { success: false, error: err?.message || String(err) };
    }
  };
}
