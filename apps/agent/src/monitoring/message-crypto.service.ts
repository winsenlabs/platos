import { Injectable, Logger } from "@nestjs/common";
import * as crypto from "crypto";

/**
 * Theme H.4 — Message-at-rest encryption (AES-256-GCM).
 *
 * Encrypts `PlatosAgentMessage.content` + `thinkingContent` so the rows in
 * Postgres are opaque to anyone with raw DB access. Decryption happens in
 * the conversation layer transparently: callers keep working with plaintext
 * strings; on the wire it's ciphertext.
 *
 * Keys are resolved from env vars:
 *   - `PLATOS_MESSAGE_ENCRYPTION_KEY`       — active key (version 1)
 *   - `PLATOS_MESSAGE_ENCRYPTION_KEY_V<N>`  — older keys for rotation reads
 *
 * Invariants:
 *   - Never log key material (only the version int may be logged).
 *   - Production fails closed when the active key is missing or invalid.
 *     Development/test may run without a key for legacy plaintext fixtures.
 *   - Rows without encKeyVersion (legacy / unconfigured) pass through
 *     untouched by `decryptIfNeeded`.
 *
 * Format: base64(iv[16] || authTag[16] || ciphertext). Keys must stay
 * distinct from the other encryption domains even though the envelope is
 * structurally identical.
 */

const ALGO = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

const DEFAULT_VERSION = 1;

function decodeKey(keyHex: string | undefined): Buffer | null {
  if (!keyHex || !/^[0-9a-f]{64}$/i.test(keyHex)) return null;
  return Buffer.from(keyHex, "hex");
}

function resolveKey(version: number): Buffer | null {
  return decodeKey(process.env[`PLATOS_MESSAGE_ENCRYPTION_KEY_V${version}`]);
}

function activeVersion(): number {
  const configured = process.env.PLATOS_MESSAGE_ENCRYPTION_KEY_V;
  if (!configured) return DEFAULT_VERSION;
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_VERSION;
}

@Injectable()
export class MessageCryptoService {
  private readonly logger = new Logger(MessageCryptoService.name);
  private readonly keyCache = new Map<number, Buffer>();
  private readonly activeVersion: number | null;

  constructor() {
    const configuredVersion = activeVersion();
    const primary = decodeKey(process.env.PLATOS_MESSAGE_ENCRYPTION_KEY);
    if (primary) {
      this.keyCache.set(configuredVersion, primary);
      this.activeVersion = configuredVersion;
    } else {
      this.activeVersion = null;
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "PLATOS_MESSAGE_ENCRYPTION_KEY is required in production and must be 64 hex characters (32 bytes)"
        );
      }
    }
  }

  /**
   * Whether encryption-on-write is available. When false, writes pass
   * through unchanged (encKeyVersion stays null) and reads of historical
   * encrypted rows still work as long as the prior key remains in env.
   */
  get available(): boolean {
    return this.activeVersion !== null;
  }

  /** Current active key version, or null when no key is configured. */
  get keyVersion(): number | null {
    return this.activeVersion;
  }

  /**
   * Encrypt a plaintext string. Returns null when no key is configured —
   * callers store plaintext + leave encKeyVersion=null in that branch.
   */
  encrypt(plaintext: string): { ciphertext: string; keyVersion: number } | null {
    if (plaintext === null || plaintext === undefined) return null;
    if (this.activeVersion === null) return null;
    const key = this.keyCache.get(this.activeVersion);
    if (!key) return null;
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const packed = Buffer.concat([iv, authTag, encrypted]);
    return { ciphertext: packed.toString("base64"), keyVersion: this.activeVersion };
  }

  /**
   * Decrypt a ciphertext that was written under the given key version.
   * Throws when the key for that version is missing in env — callers can
   * catch + degrade to "[ciphertext: key missing]" if that is the desired
   * UX. We do NOT fall back to an ephemeral key (silent data corruption).
   */
  decrypt(ciphertext: string, keyVersion: number): string {
    let key = this.keyCache.get(keyVersion);
    if (!key) {
      key = resolveKey(keyVersion) ?? undefined;
      if (!key) {
        throw new Error(
          `PlatosMessageCrypto: no key available for version ${keyVersion} — set PLATOS_MESSAGE_ENCRYPTION_KEY${
            keyVersion === 1 ? "" : `_V${keyVersion}`
          }`
        );
      }
      this.keyCache.set(keyVersion, key);
    }
    const packed = Buffer.from(ciphertext, "base64");
    const iv = packed.subarray(0, IV_LENGTH);
    const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    const out = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return out.toString("utf8");
  }

  /**
   * Convenience helper: decrypt if the row has a key version set, otherwise
   * pass through as-is. Used by the conversation read paths to implement
   * transparent decryption across the mixed plaintext/ciphertext corpus
   * during the rollout window.
   */
  decryptIfNeeded(
    content: string | null | undefined,
    keyVersion: number | null | undefined
  ): string | null {
    if (content === null || content === undefined) return null;
    if (!keyVersion) return content;
    try {
      return this.decrypt(content, keyVersion);
    } catch (err: any) {
      this.logger.error(
        `MessageCrypto decrypt failed for keyVersion=${keyVersion}: ${err?.message || err}`
      );
      // Fail-closed on decrypt: surface a sentinel so downstream code
      // doesn't leak the ciphertext as "text" to the LLM.
      return "[message ciphertext unavailable — decryption key missing]";
    }
  }

  /** Status payload for admin /secrets/status endpoint. */
  status(): { available: boolean; activeVersion: number | null } {
    return {
      available: this.available,
      activeVersion: this.activeVersion,
    };
  }

  /**
   * EOBD.20/21/22 — encrypt an arbitrary JSON-serialisable value in place.
   *
   * Returns the value wrapped in a `{__platos_enc: 1, v: N, ct: "base64"}`
   * envelope when a key is configured, or the value unchanged when no key
   * is set. Callers persist the returned value into a Prisma Json column
   * and round-trip via `decryptJsonField` on read.
   *
   * The envelope shape is self-describing — no separate `encKeyVersion`
   * column is needed, so no migration is required to adopt encryption on
   * existing JSON-typed PII fields (PlatosToolCallAudit.args/result,
   * PlatosSafetyEvent.meta, etc.).
   *
   * Non-PII identifying fields (toolName, status, etc.) stay plaintext so
   * dashboards + indexes keep working.
   */
  encryptJsonField(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (!this.available) return value;
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return value;
    }
    const enc = this.encrypt(serialized);
    if (!enc) return value;
    return { __platos_enc: 1, v: enc.keyVersion, ct: enc.ciphertext };
  }

  /**
   * Inverse of encryptJsonField. If the value carries the envelope marker
   * we decrypt + JSON.parse; otherwise passthrough unchanged (plaintext
   * rows from before encryption was configured keep working).
   */
  decryptJsonField(value: unknown): unknown {
    if (value !== null && typeof value === "object" && (value as any).__platos_enc === 1) {
      const env = value as { v: number; ct: string };
      try {
        const plain = this.decrypt(env.ct, env.v);
        return JSON.parse(plain);
      } catch (err: any) {
        this.logger.error(
          `MessageCrypto decryptJsonField failed (v=${env.v}): ${err?.message || err}`
        );
        return { __platos_enc: 1, error: "decryption_key_missing", v: env.v };
      }
    }
    return value;
  }
}
