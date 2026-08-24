/**
 * Replay guard for inbound HMAC-signed tool-call requests (PPR-71).
 *
 * The Platos agent signs every tool call with
 * `HMAC-SHA256(serviceSecret, "{ts}.{nonce}.{body}")` and forwards the
 * triple `(X-Platos-Timestamp, X-Platos-Nonce, X-Platos-Signature)` —
 * either via HTTP headers on the fallback path or embedded in the
 * `__platos` envelope on the primary WS transport.
 *
 * This module exposes a small in-memory LRU of seen nonces, keyed per
 * entity, plus `verifyAndMarkNonce()` which atomically tests-then-stores
 * a nonce. A captured request inside the skew window is rejected the
 * second time it shows up.
 *
 * Why an LRU (not Redis / a shared store)?
 *
 *   - The SDK runs inside the entity's backend; it already scales
 *     horizontally. A shared nonce store would be another piece of infra
 *     the entity has to run, for a marginal protection (each replay would
 *     simply get hashed to another replica and still hit the LRU there
 *     within the skew window since Platos doesn't re-sign).
 *   - 100k entries × ~50 bytes/nonce ≈ 5MB per process — fits everywhere.
 *   - FIFO eviction is `O(1)` with a Map (insertion-ordered keys).
 *
 * Legacy compat (PPR-71 one-release back-compat):
 *
 *   - If `nonce` is absent, the caller falls back to the legacy
 *     `{ts}.{body}` signing string. We emit a single one-time warning
 *     per process (debounced via `warnedLegacy`) and accept the request.
 *     Remove the fallback after the next release.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Default LRU cap — matches the 100k entry target from PPR-71. */
export const DEFAULT_NONCE_CACHE_SIZE = 100_000;

/** Default clock-skew window (seconds). Matches the agent side. */
export const DEFAULT_MAX_SKEW_SECONDS = 300;

/**
 * Simple FIFO-bounded Map. Insertion order is `Map`-native so we pop the
 * oldest key when we overflow. No TTL logic — entries live as long as the
 * LRU allows, which is fine because the timestamp skew-window check
 * already rejects anything older than `maxSkewSeconds`.
 */
class NonceLru {
  readonly #seen: Map<string, number> = new Map();
  readonly #capacity: number;

  constructor(capacity: number = DEFAULT_NONCE_CACHE_SIZE) {
    if (capacity <= 0) throw new Error("NonceLru capacity must be positive");
    this.#capacity = capacity;
  }

  /**
   * Test-and-insert. Returns `true` if the nonce was freshly inserted
   * (i.e. not a replay). Returns `false` if the nonce was already in
   * the cache (i.e. replay).
   */
  tryInsert(nonce: string, timestampMs: number): boolean {
    if (this.#seen.has(nonce)) return false;
    this.#seen.set(nonce, timestampMs);
    if (this.#seen.size > this.#capacity) {
      const oldest = this.#seen.keys().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    return true;
  }

  /** Exposed for tests only. */
  get size(): number {
    return this.#seen.size;
  }
}

/** Per-entity LRU. Keyed by `entityId` so multi-tenant SDK instances don't collide. */
const caches: Map<string, NonceLru> = new Map();

function getCacheFor(entityId: string, capacity: number): NonceLru {
  let cache = caches.get(entityId);
  if (!cache) {
    cache = new NonceLru(capacity);
    caches.set(entityId, cache);
  }
  return cache;
}

let warnedLegacy = false;

function emitLegacyWarning(logger?: { warn(...args: unknown[]): void }): void {
  if (warnedLegacy) return;
  warnedLegacy = true;
  const msg =
    "[@platosdev/platools-sdk] legacy HMAC request received (no X-Platos-Nonce). " +
    "Replay protection is DEGRADED for this call. Upgrade the Platos agent " +
    "to the version that signs with {ts}.{nonce}.{body} — see docs/tool-gateway.md.";
  if (logger) logger.warn(msg);
  else console.warn(msg);
}

export interface VerifyRequestInput {
  readonly entityId: string;
  readonly serviceSecret: string;
  readonly timestamp: string;
  readonly nonce?: string;
  readonly signature: string;
  readonly body: string;
  readonly now?: Date;
  readonly maxSkewSeconds?: number;
  readonly cacheCapacity?: number;
  readonly logger?: { warn(...args: unknown[]): void };
}

export type VerifyRequestResult =
  | { ok: true; usedLegacyFormat: boolean }
  | {
      ok: false;
      reason:
        | "timestamp_invalid"
        | "timestamp_skew_exceeded"
        | "signature_mismatch"
        | "nonce_replay";
    };

/**
 * Full request verification: timestamp skew, HMAC signature, and replay.
 *
 * Used by SDK-layer HTTP handlers that accept the Platos-signed POST on
 * the fallback path, as well as the primary WS transport when the
 * consumer opts in to envelope-level verification. The common case —
 * the transport layer already authenticates the WS session — still
 * benefits from this because the envelope signature is per-call.
 */
export function verifyRequest(input: VerifyRequestInput): VerifyRequestResult {
  const skew = input.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const now = input.now ?? new Date();
  const tsMs = Date.parse(input.timestamp);
  if (Number.isNaN(tsMs)) {
    return { ok: false, reason: "timestamp_invalid" };
  }
  if (Math.abs(now.getTime() - tsMs) > skew * 1000) {
    return { ok: false, reason: "timestamp_skew_exceeded" };
  }

  const usedLegacyFormat = !input.nonce;
  const signingString = usedLegacyFormat
    ? `${input.timestamp}.${input.body}`
    : `${input.timestamp}.${input.nonce}.${input.body}`;

  const expected = createHmac("sha256", input.serviceSecret)
    .update(signingString)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  let actualBuf: Buffer;
  try {
    actualBuf = Buffer.from(input.signature, "hex");
  } catch {
    return { ok: false, reason: "signature_mismatch" };
  }
  if (
    expectedBuf.length !== actualBuf.length ||
    !timingSafeEqual(expectedBuf, actualBuf)
  ) {
    return { ok: false, reason: "signature_mismatch" };
  }

  if (usedLegacyFormat) {
    emitLegacyWarning(input.logger);
    return { ok: true, usedLegacyFormat: true };
  }

  const cache = getCacheFor(
    input.entityId,
    input.cacheCapacity ?? DEFAULT_NONCE_CACHE_SIZE,
  );
  if (!cache.tryInsert(input.nonce!, tsMs)) {
    return { ok: false, reason: "nonce_replay" };
  }
  return { ok: true, usedLegacyFormat: false };
}

/** Test-only: clear the per-entity cache. */
export function __resetNonceCacheForTests(): void {
  caches.clear();
  warnedLegacy = false;
}
