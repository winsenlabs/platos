import { createDecipheriv, timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";
import type { AggregateCredentialPayloadContract } from "./cutover-ledger";

const AES_256_GCM = "aes-256-gcm";
const SECRET_STORE_NONCE_BYTES = 12;
const LEGACY_IV_BYTES = 16;
const GCM_TAG_BYTES = 16;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SHA_256_HEX = /^[0-9a-f]{64}$/;
const LEGACY_TOTP_SECRET = /^[A-Z0-9]{24}$/;

export type CutoverCryptoErrorCode =
  | "invalid_key"
  | "unsupported_version"
  | "malformed_envelope"
  | "decryption_failed"
  | "invalid_json"
  | "invalid_totp_secret"
  | "invalid_sha256"
  | "invalid_aggregate"
  | "unsafe_evidence";

/** Stable cutover-only failure that never includes source or key material. */
export class CutoverCryptoError extends Error {
  constructor(readonly code: CutoverCryptoErrorCode) {
    super(`Cutover cryptographic validation failed (${code})`);
    this.name = "CutoverCryptoError";
  }

  toJSON(): Readonly<{ name: "CutoverCryptoError"; code: CutoverCryptoErrorCode }> {
    return Object.freeze({ name: "CutoverCryptoError", code: this.code });
  }

  [inspect.custom](): string {
    return `${this.name} { code: ${JSON.stringify(this.code)} }`;
  }
}

export type CutoverJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CutoverJsonValue[]
  | { readonly [key: string]: CutoverJsonValue };

export interface DecodedCutoverValue<T> {
  readonly encoding: "PLAINTEXT" | "ENVELOPE";
  readonly keyVersion: number | null;
  readonly value: T;
}

export interface SecretStoreSourceRow {
  readonly version: unknown;
  readonly value: unknown;
}

/**
 * Decode the two inherited SecretStore formats only. Version 1 is JSONB
 * plaintext. Version 2 is the exact hex AES-256-GCM envelope written by the
 * webapp under ENCRYPTION_KEY. No other version or plaintext fallback exists.
 */
export function decodeLegacySecretStoreJson(
  row: SecretStoreSourceRow,
  encryptionKeyInput: string
): CutoverJsonValue {
  if (row.version === "1") return assertJsonValue(row.value);
  if (row.version !== "2") throw failure("unsupported_version");

  const envelope = exactObject(row.value, ["ciphertext", "nonce", "tag"]);
  const nonce = decodeHex(envelope.nonce, SECRET_STORE_NONCE_BYTES);
  const tag = decodeHex(envelope.tag, GCM_TAG_BYTES);
  const ciphertext = decodeHex(envelope.ciphertext);
  if (ciphertext.length === 0) throw failure("malformed_envelope");

  const key = decodeLegacyEncryptionKey(encryptionKeyInput);
  const plaintext = decryptGcm(key, nonce, tag, ciphertext);
  return parseJson(plaintext);
}

/** Decode the legacy agent SecretsService packed base64(iv16 || tag16 || ciphertext). */
export function decodeLegacyPlatosSecret(
  packedCiphertext: unknown,
  platosEncryptionKey: string
): string {
  const packed = decodeCanonicalBase64(packedCiphertext);
  if (packed.length < LEGACY_IV_BYTES + GCM_TAG_BYTES) {
    throw failure("malformed_envelope");
  }
  const key = decodeHexKey(platosEncryptionKey);
  return decodeUtf8(
    decryptGcm(
      key,
      packed.subarray(0, LEGACY_IV_BYTES),
      packed.subarray(LEGACY_IV_BYTES, LEGACY_IV_BYTES + GCM_TAG_BYTES),
      packed.subarray(LEGACY_IV_BYTES + GCM_TAG_BYTES)
    )
  );
}

/**
 * Decode a mixed legacy message column. A present version always requires a
 * valid packed message envelope and an exact key-ring match. An absent version
 * is the only plaintext classification.
 */
export function decodeVersionedLegacyMessage(
  sourceValue: unknown,
  sourceKeyVersion: unknown,
  messageKeys: Readonly<Record<string, string>>
): DecodedCutoverValue<string | null> {
  if (sourceKeyVersion === null || sourceKeyVersion === undefined) {
    if (sourceValue !== null && typeof sourceValue !== "string") {
      throw failure("malformed_envelope");
    }
    return Object.freeze({ encoding: "PLAINTEXT", keyVersion: null, value: sourceValue });
  }

  const keyVersion = positiveVersion(sourceKeyVersion);
  if (typeof sourceValue !== "string") throw failure("malformed_envelope");
  return Object.freeze({
    encoding: "ENVELOPE",
    keyVersion,
    value: decryptPackedMessage(sourceValue, keyVersion, messageKeys),
  });
}

export type LegacyJsonMessageStorage = "JSONB" | "TEXT";

/**
 * Decode legacy JSON-field message envelopes. Only an own `__platos_enc: 1`
 * marker classifies an envelope. A reserved marker with another value is an
 * unsupported format; a recognized marker with malformed fields fails closed.
 */
export function decodeLegacyJsonMessage(
  sourceValue: unknown,
  storage: LegacyJsonMessageStorage,
  messageKeys: Readonly<Record<string, string>>
): DecodedCutoverValue<CutoverJsonValue | string> {
  const candidate = jsonEnvelopeCandidate(sourceValue, storage);
  if (!candidate.envelope) {
    return Object.freeze({
      encoding: "PLAINTEXT",
      keyVersion: null,
      value: storage === "JSONB" ? assertJsonValue(sourceValue) : candidate.plaintext,
    });
  }

  const envelope = exactObject(candidate.envelope, ["__platos_enc", "ct", "v"]);
  if (envelope.__platos_enc !== 1) throw failure("unsupported_version");
  const keyVersion = positiveVersion(envelope.v);
  if (typeof envelope.ct !== "string") throw failure("malformed_envelope");
  const plaintext = decryptPackedMessage(envelope.ct, keyVersion, messageKeys);
  return Object.freeze({
    encoding: "ENVELOPE",
    keyVersion,
    value: parseJson(Buffer.from(plaintext, "utf8")),
  });
}

/** Convert the exact inherited MFA `{secret}` payload to canonical unpadded base32. */
export function convertLegacyTotpSecretToBase32(value: unknown): string {
  const payload = exactObject(value, ["secret"]);
  if (typeof payload.secret !== "string" || !LEGACY_TOTP_SECRET.test(payload.secret)) {
    throw failure("invalid_totp_secret");
  }
  return encodeBase32(Buffer.from(payload.secret, "utf8"));
}

/** Validate canonical uppercase, unpadded base32 and return an independent byte buffer. */
export function decodeBase32TotpSecret(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Z2-7]+$/.test(value)) {
    throw failure("invalid_totp_secret");
  }

  let bits = 0;
  let accumulator = 0;
  const output: number[] = [];
  for (const character of value) {
    accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      output.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bits > 0 && (accumulator & ((1 << bits) - 1)) !== 0) {
    throw failure("invalid_totp_secret");
  }

  const decoded = Buffer.from(output);
  if (decoded.length === 0 || encodeBase32(decoded) !== value) {
    throw failure("invalid_totp_secret");
  }
  return decoded;
}

/** Accept only the canonical lowercase representation emitted by SHA-256 digest("hex"). */
export function validateSha256Hex(value: unknown): string {
  if (typeof value !== "string" || !SHA_256_HEX.test(value)) {
    throw failure("invalid_sha256");
  }
  return value;
}

/** Validate all aggregate components and serialize a stable key-sorted JSON object. */
export function serializeAggregateCredentialPayload(
  contract: AggregateCredentialPayloadContract,
  decodedSourceValues: Readonly<Record<string, unknown>>
): string {
  const payload: Record<string, string> = {};
  let present = 0;

  for (const component of contract.components) {
    const value = decodedSourceValues[component.sourceField];
    if (value === null || value === undefined) {
      if (component.requiredness === "REQUIRED") throw failure("invalid_aggregate");
      continue;
    }
    if (typeof value !== "string" || value.length === 0 || !isValidUtf8String(value)) {
      throw failure("invalid_aggregate");
    }
    if (Object.hasOwn(payload, component.payloadKey)) throw failure("invalid_aggregate");
    payload[component.payloadKey] = value;
    present += 1;
  }

  if (
    present < contract.minimumPresentComponents ||
    (present === 0 && contract.emptyPayloadPolicy === "BLOCK_CUTOVER")
  ) {
    throw failure("invalid_aggregate");
  }

  return JSON.stringify(
    Object.fromEntries(
      Object.entries(payload).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    )
  );
}

const SENSITIVE_EVIDENCE_KEYS = new Set([
  "authtag",
  "ciphertext",
  "ct",
  "digest",
  "hash",
  "iv",
  "keyhash",
  "material",
  "nonce",
  "payload",
  "plaintext",
  "rootkey",
  "salt",
  "secret",
  "sha256",
  "tag",
  "tokenhash",
  "value",
]);

/**
 * Assert that metadata-only cutover evidence contains no cryptographic fields,
 * hash-shaped values, or caller-supplied sensitive values. Failures disclose no
 * rejected key, value, hash, plaintext, or ciphertext.
 */
export function assertSecretFreeCutoverEvidence(
  evidence: unknown,
  forbiddenValues: readonly string[] = []
): void {
  const seen = new Set<object>();
  const forbidden = forbiddenValues.filter((value) => value.length > 0);

  const visit = (value: unknown): void => {
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw failure("unsafe_evidence");
      return;
    }
    if (typeof value === "string") {
      if (SHA_256_HEX.test(value) || forbidden.some((entry) => value.includes(entry))) {
        throw failure("unsafe_evidence");
      }
      return;
    }
    if (typeof value !== "object") throw failure("unsafe_evidence");
    if (seen.has(value)) throw failure("unsafe_evidence");
    seen.add(value);

    if (Array.isArray(value)) {
      const propertyNames = Object.getOwnPropertyNames(value);
      if (
        Object.getOwnPropertySymbols(value).length > 0 ||
        propertyNames.length !== value.length + 1 ||
        !propertyNames.includes("length")
      ) {
        throw failure("unsafe_evidence");
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) throw failure("unsafe_evidence");
        visit(descriptor.value);
      }
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw failure("unsafe_evidence");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) throw failure("unsafe_evidence");
    if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) {
      throw failure("unsafe_evidence");
    }

    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw failure("unsafe_evidence");
      if (isSensitiveEvidenceKey(key)) throw failure("unsafe_evidence");
      visit(descriptor.value);
    }
  };

  visit(evidence);
}

function jsonEnvelopeCandidate(
  sourceValue: unknown,
  storage: LegacyJsonMessageStorage
): { readonly envelope: Record<string, unknown> | null; readonly plaintext: string } {
  if (storage === "JSONB") {
    if (isPlainObject(sourceValue) && Object.hasOwn(sourceValue, "__platos_enc")) {
      return { envelope: sourceValue, plaintext: "" };
    }
    return { envelope: null, plaintext: "" };
  }
  if (typeof sourceValue !== "string") throw failure("malformed_envelope");

  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceValue);
  } catch {
    return { envelope: null, plaintext: sourceValue };
  }
  if (isPlainObject(parsed) && Object.hasOwn(parsed, "__platos_enc")) {
    return { envelope: parsed, plaintext: sourceValue };
  }
  return { envelope: null, plaintext: sourceValue };
}

function decryptPackedMessage(
  packedCiphertext: string,
  keyVersion: number,
  messageKeys: Readonly<Record<string, string>>
): string {
  const configuredKey = messageKeys[String(keyVersion)];
  if (configuredKey === undefined) throw failure("invalid_key");
  return decodeLegacyPlatosSecret(packedCiphertext, configuredKey);
}

function decodeLegacyEncryptionKey(value: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  const legacy = Buffer.from(value, "utf8");
  if (legacy.length !== 32) throw failure("invalid_key");
  return legacy;
}

function decodeHexKey(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw failure("invalid_key");
  }
  return Buffer.from(value, "hex");
}

function decryptGcm(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer): Buffer {
  try {
    const decipher = createDecipheriv(AES_256_GCM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw failure("decryption_failed");
  }
}

function decodeHex(value: unknown, expectedBytes?: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]*$/i.test(value)
  ) {
    throw failure("malformed_envelope");
  }
  const decoded = Buffer.from(value, "hex");
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw failure("malformed_envelope");
  }
  return decoded;
}

function decodeCanonicalBase64(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw failure("malformed_envelope");
  }
  const decoded = Buffer.from(value, "base64");
  const canonical = Buffer.from(decoded.toString("base64"));
  const supplied = Buffer.from(value);
  if (canonical.length !== supplied.length || !timingSafeEqual(canonical, supplied)) {
    throw failure("malformed_envelope");
  }
  return decoded;
}

function parseJson(value: Buffer): CutoverJsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(value));
  } catch (error) {
    if (error instanceof CutoverCryptoError) throw error;
    throw failure("invalid_json");
  }
  return assertJsonValue(parsed);
}

function decodeUtf8(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw failure("invalid_json");
  }
}

function assertJsonValue(value: unknown, ancestors = new Set<object>()): CutoverJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw failure("invalid_json");
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) throw failure("invalid_json");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const propertyNames = Object.getOwnPropertyNames(value);
      if (propertyNames.length !== value.length + 1 || !propertyNames.includes("length")) {
        throw failure("invalid_json");
      }
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) throw failure("invalid_json");
        return assertJsonValue(descriptor.value, ancestors);
      });
    }
    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
      throw failure("invalid_json");
    }
    if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) {
      throw failure("invalid_json");
    }
    return Object.fromEntries(
      Object.keys(value).map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) throw failure("invalid_json");
        return [key, assertJsonValue(descriptor.value, ancestors)];
      })
    );
  } finally {
    ancestors.delete(value);
  }
}

function exactObject(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
    throw failure("malformed_envelope");
  }
  const actualKeys = Object.getOwnPropertyNames(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw failure("malformed_envelope");
  }
  for (const key of actualKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw failure("malformed_envelope");
    }
  }
  return value;
}

function isSensitiveEvidenceKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (SENSITIVE_EVIDENCE_KEYS.has(normalized)) return true;
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
  const tokenSet = new Set(tokens);
  return (
    [
      "ciphertext",
      "digest",
      "hash",
      "iv",
      "material",
      "nonce",
      "payload",
      "plaintext",
      "salt",
      "secret",
      "sha256",
      "tag",
      "value",
    ].some((token) => tokenSet.has(token)) ||
    (tokenSet.has("auth") && tokenSet.has("tag")) ||
    (tokenSet.has("root") && tokenSet.has("key")) ||
    (tokenSet.has("encryption") && tokenSet.has("key"))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw failure("unsupported_version");
  }
  return value as number;
}

function encodeBase32(input: Buffer): string {
  let bits = 0;
  let accumulator = 0;
  let output = "";
  for (const byte of input) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  return output;
}

function isValidUtf8String(value: string): boolean {
  const encoded = Buffer.from(value, "utf8");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(encoded) === value;
  } catch {
    return false;
  }
}

function failure(code: CutoverCryptoErrorCode): CutoverCryptoError {
  return new CutoverCryptoError(code);
}
