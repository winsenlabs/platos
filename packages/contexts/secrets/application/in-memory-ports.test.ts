// Non-vacuity proof for the doubles every other test in this package relies on.
//
// If the fake cipher opened anything handed to it, every "fails closed" assertion
// elsewhere would pass for the wrong reason. So the failure modes are asserted
// here directly: a wrong key, a relocated binding, a flipped ciphertext byte and a
// flipped tag byte must each refuse to open, exactly as AES-256-GCM would.

import { asIdentifier, unwrap } from "@platos/kernel";
import type { EnvironmentId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { EnvelopeBinding } from "../domain/envelope.js";
import { asSecretsIdentifier } from "../domain/ids.js";
import type { CredentialId, RootKeyVersion, SecretRevision } from "../domain/ids.js";
import { secretMaterial } from "../domain/secret-material.js";
import {
  inMemoryAeadCipher,
  inMemoryClock,
  inMemoryHasher,
  inMemoryIdGenerator,
  inMemoryKeyRing,
} from "./in-memory-crypto.js";
import type { RootKeyHandle } from "./ports/index.js";

const binding: EnvelopeBinding = {
  environmentId: asIdentifier<EnvironmentId>("env-1"),
  credentialId: asSecretsIdentifier<CredentialId>("cred-1"),
  secretRevision: 1 as SecretRevision,
  formatVersion: 1,
  rootKeyVersion: 1 as RootKeyVersion,
};

const PLAINTEXT = "sentinel-provider-secret";

function ringAndCipher() {
  const ring = inMemoryKeyRing(1, [1, 2]);
  return { ring, cipher: inMemoryAeadCipher(ring) };
}

describe("the in-memory cipher behaves like authenticated encryption", () => {
  it("round-trips and never reuses a salt or a nonce", async () => {
    const { ring, cipher } = ringAndCipher();
    const key = unwrap(await ring.handle(1 as RootKeyVersion));
    const first = unwrap(await cipher.seal({ key, binding, plaintext: secretMaterial(PLAINTEXT) }));
    const second = unwrap(await cipher.seal({ key, binding, plaintext: secretMaterial(PLAINTEXT) }));

    expect(unwrap(await cipher.open({ key, binding, envelope: first })).reveal()).toBe(PLAINTEXT);
    expect([...first.salt]).not.toEqual([...second.salt]);
    expect([...first.nonce]).not.toEqual([...second.nonce]);
    expect([...first.ciphertext]).not.toEqual([...second.ciphertext]);
  });

  it("hides the plaintext in the sealed bytes", async () => {
    const { ring, cipher } = ringAndCipher();
    const key = unwrap(await ring.handle(1 as RootKeyVersion));
    const sealed = unwrap(await cipher.seal({ key, binding, plaintext: secretMaterial(PLAINTEXT) }));
    expect(JSON.stringify([...sealed.ciphertext])).not.toContain(PLAINTEXT);
  });

  it("refuses a wrong key, a relocated binding and either kind of tampering", async () => {
    const { ring, cipher } = ringAndCipher();
    const key = unwrap(await ring.handle(1 as RootKeyVersion));
    const otherKey = unwrap(await ring.handle(2 as RootKeyVersion));
    const sealed = unwrap(await cipher.seal({ key, binding, plaintext: secretMaterial(PLAINTEXT) }));

    const flippedCiphertext = Uint8Array.from(sealed.ciphertext);
    flippedCiphertext[0] = (flippedCiphertext[0] ?? 0) ^ 1;
    const flippedTag = Uint8Array.from(sealed.authTag);
    flippedTag[0] = (flippedTag[0] ?? 0) ^ 1;

    const refusals = [
      await cipher.open({ key: otherKey, binding, envelope: sealed }),
      await cipher.open({ key, binding: { ...binding, secretRevision: 2 as SecretRevision }, envelope: sealed }),
      await cipher.open({ key, binding, envelope: { ...sealed, ciphertext: flippedCiphertext } }),
      await cipher.open({ key, binding, envelope: { ...sealed, authTag: flippedTag } }),
    ];
    for (const refusal of refusals) {
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.error.code).toBe("CREDENTIAL_UNAVAILABLE");
    }
  });

  it("refuses to seal or open under a key that has left the ring", async () => {
    const { ring, cipher } = ringAndCipher();
    const key = unwrap(await ring.handle(2 as RootKeyVersion));
    ring.retireVersion(2);
    const sealed = await cipher.seal({ key, binding, plaintext: secretMaterial(PLAINTEXT) });
    expect(sealed.ok).toBe(false);
    expect((await ring.handle(2 as RootKeyVersion)).ok).toBe(false);
  });
});

describe("the remaining doubles keep their contracts", () => {
  it("hashes one way and verifies without revealing", async () => {
    const hasher = inMemoryHasher();
    const digest = unwrap(await hasher.hash(secretMaterial(PLAINTEXT)));
    expect(digest).not.toContain(PLAINTEXT);
    expect(unwrap(await hasher.verify(secretMaterial(PLAINTEXT), digest))).toBe(true);
    expect(unwrap(await hasher.verify(secretMaterial("other"), digest))).toBe(false);
  });

  it("makes time an input rather than a reading", () => {
    const clock = inMemoryClock(new Date("2026-01-01T00:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    clock.advance(1_000);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:01.000Z");
  });

  it("makes identity an input, and never repeats one", () => {
    const ids = inMemoryIdGenerator("t");
    const minted = [ids.uuid(), ids.uuid(), ids.ulid()];
    expect(new Set(minted).size).toBe(3);
  });

  it("reports a ring whose active version has been taken out as unusable", async () => {
    const ring = inMemoryKeyRing(1, [1]);
    ring.retireVersion(1);
    const state = await ring.state();
    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.error.code).toBe("INVALID_KEY_RING");
  });

  it("keeps a root key handle opaque beyond its version", async () => {
    const ring = inMemoryKeyRing(1, [1]);
    const key: RootKeyHandle = unwrap(await ring.handle(1 as RootKeyVersion));
    expect(Object.keys(key)).toEqual(["rootKeyVersion"]);
  });
});
