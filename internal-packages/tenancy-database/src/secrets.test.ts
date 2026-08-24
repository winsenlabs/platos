import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, test } from "vitest";
import {
  CredentialRootKeyRing,
  PlatosSecretStoreError,
  SecretMaterial,
  decryptCredentialSecret,
  encryptCredentialSecret,
} from "./secrets";

const context = {
  credentialId: "11111111-1111-4111-8111-111111111111",
  environmentId: "22222222-2222-4222-8222-222222222222",
  secretRevision: 1,
  formatVersion: 1,
  rootKeyVersion: 1,
};

describe("Platos credential envelope", () => {
  test("round-trips with a random envelope and never reuses nonce or salt", () => {
    const key = randomBytes(32);
    const first = encryptCredentialSecret(key, context, "sentinel-provider-secret");
    const second = encryptCredentialSecret(key, context, "sentinel-provider-secret");

    expect(decryptCredentialSecret(key, context, first).reveal()).toBe("sentinel-provider-secret");
    expect(Buffer.from(first.nonce).equals(Buffer.from(second.nonce))).toBe(false);
    expect(Buffer.from(first.salt).equals(Buffer.from(second.salt))).toBe(false);
  });

  test.each([
    ["environment", { ...context, environmentId: "33333333-3333-4333-8333-333333333333" }],
    ["credential", { ...context, credentialId: "44444444-4444-4444-8444-444444444444" }],
    ["revision", { ...context, secretRevision: 2 }],
    ["format", { ...context, formatVersion: 2 }],
    ["root version", { ...context, rootKeyVersion: 2 }],
  ])("rejects envelope relocation across %s", (_label, wrongContext) => {
    const key = randomBytes(32);
    const envelope = encryptCredentialSecret(key, context, "sentinel-provider-secret");
    expect(() => decryptCredentialSecret(key, wrongContext, envelope)).toThrowError(
      new PlatosSecretStoreError("credential_unavailable")
    );
  });

  test("rejects ciphertext, tag, and root-key tampering with one stable error", () => {
    const key = randomBytes(32);
    const envelope = encryptCredentialSecret(key, context, "sentinel-provider-secret");
    const tamperedCiphertext = Buffer.from(envelope.ciphertext);
    tamperedCiphertext[0] ^= 1;
    const tamperedTag = Buffer.from(envelope.authTag);
    tamperedTag[0] ^= 1;

    for (const check of [
      () => decryptCredentialSecret(randomBytes(32), context, envelope),
      () => decryptCredentialSecret(key, context, { ...envelope, ciphertext: tamperedCiphertext }),
      () => decryptCredentialSecret(key, context, { ...envelope, authTag: tamperedTag }),
    ]) {
      expect(check).toThrowError(new PlatosSecretStoreError("credential_unavailable"));
    }
  });

  test("redacts JSON, inspection, spread, enumeration, coercion, and captured errors", () => {
    const secret = "sentinel-provider-secret";
    const material = new SecretMaterial(secret);
    const captured = { material, error: new Error(String(material)) };

    expect(JSON.stringify(captured)).not.toContain(secret);
    expect(JSON.stringify(captured)).toContain("REDACTED");
    expect(inspect(material)).toBe("[REDACTED SecretMaterial]");
    expect(String(material)).toBe("[REDACTED SecretMaterial]");
    expect({ ...material }).toEqual({});
    expect(Object.keys(material)).toEqual([]);
    expect(inspect(captured)).not.toContain(secret);
    expect(captured.error.message).not.toContain(secret);
  });

  test("requires a positive active version and exact 32-byte root keys", () => {
    expect(() => new CredentialRootKeyRing({ activeVersion: 0, keys: {} })).toThrowError(
      new PlatosSecretStoreError("invalid_key_ring")
    );
    expect(
      () => new CredentialRootKeyRing({ activeVersion: 1, keys: { 1: "not-a-key" } })
    ).toThrowError(new PlatosSecretStoreError("invalid_key_ring"));
    expect(
      () => new CredentialRootKeyRing({ activeVersion: 2, keys: { 1: randomBytes(32) } })
    ).toThrowError(new PlatosSecretStoreError("invalid_key_ring"));

    const ring = new CredentialRootKeyRing({
      activeVersion: 2,
      keys: { 1: randomBytes(32), 2: randomBytes(32).toString("hex") },
    });
    expect(ring.activeVersion).toBe(2);
    expect(ring.key(1)).toHaveLength(32);
    expect(() => ring.key(3)).toThrowError(
      new PlatosSecretStoreError("credential_unavailable")
    );
  });
});
