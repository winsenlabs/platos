// What a job payload, and a job result, are allowed to contain.
//
// This is a faithful port of the admission rules in the live
// `job-execution.service.ts`. They are pure predicates over a JSON value and
// were already framework-free; extracting them changes where they live, not what
// they accept.
//
// THE RULES ARE FAIL-CLOSED. Every limit rejects rather than truncates, and the
// sensitive-material checks reject rather than redact. A truncated payload that
// still executes is worse than a refused one: the handler runs on data the caller
// did not send.
//
// WHY A PAYLOAD IS SCANNED FOR SECRETS AT ALL. A job payload is persisted, logged
// and replayed from an idempotency record, so a credential that reaches it is
// durably captured in three places. The key-name check catches the common shape
// (`{ apiKey: "..." }`) and the value check catches the pasted-connection-string
// shape. Neither is a general secret scanner and neither claims to be — see
// `containsSensitiveMaterial` for exactly what it matches.

import { asIdentifier, type JsonValue } from "@platos/kernel";

import type { RequestDigest } from "./identifiers.js";

/** The live limits, unchanged. */
export const PAYLOAD_LIMITS = Object.freeze({
  maxJsonBytes: 64 * 1024,
  maxDepth: 8,
  maxCollectionItems: 100,
  maxStringLength: 8192,
  maxKeyLength: 128,
});

export type PayloadLimits = typeof PAYLOAD_LIMITS;

/**
 * Key names that may never appear in a payload. The first three are
 * prototype-pollution vectors; the rest are credential-shaped. `handler` and
 * `source` are here because a payload carrying either is trying to smuggle
 * executable text into a sandbox that takes its code from the row, not the call.
 */
const SENSITIVE_KEY_NAMES: ReadonlySet<string> = new Set([
  "proto",
  "constructor",
  "prototype",
  "secret",
  "password",
  "token",
  "authorization",
  "credential",
  "handler",
  "source",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "privatekey",
  "databaseurl",
  "connectionstring",
]);

const SENSITIVE_KEY_SUFFIX =
  /(?:secret|password|authorization|credential|token|apikey|privatekey|databaseurl|connectionstring|handlersource|compiledhandler)$/;

const CONNECTION_STRING = /(?:postgres(?:ql)?|mysql|redis):\/\/[^\s/:@]+:[^\s/@]+@/i;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i;
const LABELLED_SECRET =
  /\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S+/i;

/**
 * Normalise a key for comparison: strip everything that is not alphanumeric and
 * lower-case the rest, so `API_KEY`, `api-key` and `apiKey` are one name.
 */
export function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_NAMES.has(normalized) || SENSITIVE_KEY_SUFFIX.test(normalized);
}

/**
 * True when a string looks like it carries a credential.
 *
 * `knownSecrets` are values the composition root already knows are secret (the
 * live caller passes the internal auth token and the database URL). They are
 * matched by containment, so a payload quoting one anywhere is refused. The three
 * patterns catch connection strings, bearer tokens, and `key: value` pairs whose
 * key is credential-shaped. It matches nothing else, and is not a general scanner.
 */
export function containsSensitiveMaterial(value: string, knownSecrets: readonly string[]): boolean {
  if (knownSecrets.some((secret) => secret.length > 0 && value.includes(secret))) return true;
  return CONNECTION_STRING.test(value) || BEARER_TOKEN.test(value) || LABELLED_SECRET.test(value);
}

/** An object with a null or `Object.prototype` prototype — nothing exotic. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * The admission predicate. Recursive, depth-bounded, and total: every branch
 * returns a boolean and none throws.
 *
 * `NaN` and `Infinity` are refused because they do not survive `JSON.stringify`
 * — they become `null`, so accepting them would silently change the value between
 * admission and persistence.
 */
export function isAdmissibleJson(
  value: unknown,
  knownSecrets: readonly string[],
  limits: PayloadLimits = PAYLOAD_LIMITS,
  depth = 0,
): value is JsonValue {
  if (depth > limits.maxDepth) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    return value.length <= limits.maxStringLength && !containsSensitiveMaterial(value, knownSecrets);
  }
  if (Array.isArray(value)) {
    return (
      value.length <= limits.maxCollectionItems &&
      value.every((item) => isAdmissibleJson(item, knownSecrets, limits, depth + 1))
    );
  }
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= limits.maxCollectionItems &&
    entries.every(
      ([key, item]) =>
        key.length > 0 &&
        key.length <= limits.maxKeyLength &&
        !isSensitiveKey(key) &&
        isAdmissibleJson(item, knownSecrets, limits, depth + 1),
    )
  );
}

/** Byte length of the serialised form, which is what the size cap governs. */
export function serializedByteLength(value: JsonValue): number {
  // `Buffer` is a Node global and this layer may not assume a runtime, so the
  // byte count is derived from the UTF-8 encoding of the serialised string.
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function withinSizeCap(value: JsonValue, limits: PayloadLimits = PAYLOAD_LIMITS): boolean {
  return serializedByteLength(value) <= limits.maxJsonBytes;
}

/**
 * A key-order-independent serialisation.
 *
 * Two requests that differ only in the order their JSON keys arrived are the SAME
 * request, and must hash the same or a retry would be refused as a conflict.
 * `JSON.stringify` preserves insertion order, so it cannot be used here.
 */
export function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, JsonValue>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key] as JsonValue)}`)
    .join(",")}}`;
}

/**
 * The port a digest is computed through. Hashing is I/O-free but it is still a
 * primitive this layer must not choose an implementation for, so it arrives as a
 * function and the adapter supplies SHA-256 (the live algorithm).
 */
export type DigestFunction = (input: string) => string;

export function digestOf(digest: DigestFunction, value: JsonValue): RequestDigest {
  return asIdentifier<RequestDigest>(digest(stableJson(value)));
}
