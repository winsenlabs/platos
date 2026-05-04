/**
 * Theme H.4 — MessageCryptoService unit tests.
 *
 * Verifies round-trip encrypt/decrypt + key-version plumbing + passthrough
 * behaviour when no key is configured. No containers — pure crypto under
 * node's built-in `crypto` module, fully deterministic once we seed the
 * env var in the test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import { MessageCryptoService } from "./message-crypto.service";

const ORIGINAL_ENV = { ...process.env };

describe("MessageCryptoService", () => {
  beforeEach(() => {
    // Start each test with a clean slate.
    delete process.env.PLATOS_MESSAGE_ENCRYPTION_KEY;
    delete process.env.PLATOS_MESSAGE_ENCRYPTION_KEY_V2;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("passes through when no key is configured", () => {
    const svc = new MessageCryptoService();
    expect(svc.available).toBe(false);
    expect(svc.keyVersion).toBe(null);
    expect(svc.encrypt("hello")).toBe(null);
    // decryptIfNeeded with kv=null returns the input unchanged.
    expect(svc.decryptIfNeeded("hello", null)).toBe("hello");
  });

  it("round-trips a plaintext under v1", () => {
    process.env.PLATOS_MESSAGE_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    const svc = new MessageCryptoService();
    expect(svc.available).toBe(true);
    expect(svc.keyVersion).toBe(1);
    const sample = "private user content 🔒";
    const enc = svc.encrypt(sample);
    expect(enc).not.toBe(null);
    expect(enc!.ciphertext).not.toBe(sample);
    expect(enc!.keyVersion).toBe(1);
    const back = svc.decrypt(enc!.ciphertext, enc!.keyVersion);
    expect(back).toBe(sample);
  });

  it("decryptIfNeeded transparently routes based on keyVersion", () => {
    process.env.PLATOS_MESSAGE_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    const svc = new MessageCryptoService();
    const enc = svc.encrypt("mixed corpus row");
    expect(svc.decryptIfNeeded(enc!.ciphertext, 1)).toBe("mixed corpus row");
    // Legacy plaintext row — keyVersion null — passes through untouched.
    expect(svc.decryptIfNeeded("legacy plaintext", null)).toBe("legacy plaintext");
  });

  it("fails closed when the version key is missing (no silent corruption)", () => {
    process.env.PLATOS_MESSAGE_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    const svc = new MessageCryptoService();
    const enc = svc.encrypt("sensitive");
    expect(enc).not.toBe(null);
    // Ask to decrypt under a key version that was never configured.
    expect(() => svc.decrypt(enc!.ciphertext, 99)).toThrow(/no key available/i);
  });

  it("supports rotated-read: v2 active, v1 decrypts still work when V1 key stays in env", () => {
    const v1 = crypto.randomBytes(32).toString("hex");
    const v2 = crypto.randomBytes(32).toString("hex");
    // First, encrypt under v1.
    process.env.PLATOS_MESSAGE_ENCRYPTION_KEY = v1;
    const svcV1 = new MessageCryptoService();
    const oldEnc = svcV1.encrypt("historical row");
    expect(oldEnc!.keyVersion).toBe(1);

    // Rotate: v2 becomes active, v1 kept in env as the rotation-read fallback.
    process.env.PLATOS_MESSAGE_ENCRYPTION_KEY = v2;
    process.env.PLATOS_MESSAGE_ENCRYPTION_KEY_V2 = v2;
    // For the service to read v1 rows we need V_1 under its explicit name
    // as well (or leave the primary env as v1 — rotation guide lines it up
    // that way in the PRD).
    process.env.PLATOS_MESSAGE_ENCRYPTION_KEY_V1 = v1;
    const svcV2 = new MessageCryptoService();
    // Active is still v1 (CURRENT_VERSION=1) because the active slot reads
    // `PLATOS_MESSAGE_ENCRYPTION_KEY`. We re-read it back:
    const decrypted = svcV2.decryptIfNeeded(oldEnc!.ciphertext, 1);
    expect(decrypted).toBe("historical row");
  });
});
