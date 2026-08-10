/**
 * Paid Service Registry
 *
 * The catalog of services this automaton sells over x402. Stored as a JSON
 * blob in the kv table (same mechanism as orchestrator.state) — no migration
 * needed, survives restarts, and the earning server reads it per-request so
 * edits take effect immediately.
 *
 * v1 service type: prompt-backed. The agent authors a system prompt that
 * defines the service; a buyer pays, POSTs an input, and receives the
 * completion. The one thing an automaton can genuinely sell from day one
 * is its own inference and judgment.
 */

import type { AutomatonDatabase } from "../types.js";

const KV_KEY = "earning.services";

export interface PaidService {
  /** URL-safe slug, becomes the endpoint path /svc/<name>. */
  name: string;
  /** Shown in the public service directory. */
  description: string;
  /** Price per call in USD. */
  priceUsd: number;
  /** System prompt that defines what the service does with buyer input. */
  prompt: string;
  createdAt: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const MIN_PRICE_USD = 0.01;
export const MAX_PRICE_USD = 999;
const MAX_PROMPT_CHARS = 4000;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_SERVICES = 25;

export function listServices(db: AutomatonDatabase): PaidService[] {
  try {
    const raw = db.getKV(KV_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getService(
  db: AutomatonDatabase,
  name: string,
): PaidService | undefined {
  return listServices(db).find((s) => s.name === name);
}

/** Validate and upsert a service. Returns an error string, or null on success. */
export function saveService(
  db: AutomatonDatabase,
  service: Omit<PaidService, "createdAt">,
): string | null {
  if (!NAME_RE.test(service.name)) {
    return `Invalid service name "${service.name}". Use 2-41 chars: lowercase letters, digits, hyphens.`;
  }
  if (!Number.isFinite(service.priceUsd) || service.priceUsd < MIN_PRICE_USD || service.priceUsd > MAX_PRICE_USD) {
    return `Price must be between $${MIN_PRICE_USD} and $${MAX_PRICE_USD} per call.`;
  }
  if (!service.description?.trim() || service.description.length > MAX_DESCRIPTION_CHARS) {
    return `Description is required (max ${MAX_DESCRIPTION_CHARS} chars).`;
  }
  if (!service.prompt?.trim() || service.prompt.length > MAX_PROMPT_CHARS) {
    return `Service prompt is required (max ${MAX_PROMPT_CHARS} chars).`;
  }

  const services = listServices(db);
  const existing = services.findIndex((s) => s.name === service.name);
  if (existing === -1 && services.length >= MAX_SERVICES) {
    return `Service limit reached (${MAX_SERVICES}). Remove one first.`;
  }

  const entry: PaidService = {
    name: service.name,
    description: service.description.trim(),
    priceUsd: service.priceUsd,
    prompt: service.prompt,
    createdAt:
      existing >= 0 ? services[existing].createdAt : new Date().toISOString(),
  };
  if (existing >= 0) {
    services[existing] = entry;
  } else {
    services.push(entry);
  }
  db.setKV(KV_KEY, JSON.stringify(services));
  return null;
}

export function removeService(db: AutomatonDatabase, name: string): boolean {
  const services = listServices(db);
  const next = services.filter((s) => s.name !== name);
  if (next.length === services.length) return false;
  db.setKV(KV_KEY, JSON.stringify(next));
  return true;
}
