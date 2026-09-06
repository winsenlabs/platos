// Does this adapter speak the format every stored envelope was written in?
//
// The three vectors it opens were produced by
// `internal-packages/tenancy-database/src/secrets.ts`, which this issue does not
// edit. That is the whole design of the file: an assertion comparing this
// adapter's `envelopeAad` against the domain's `envelopeAad` compares two things
// one tranche controls, so a mutation that changed the domain constant would move
// both sides and stay green. A ciphertext moves with neither.

import { describe, expect, it } from "vitest";

import type { EnvelopeBinding, RootKeyVersion, SecretRevision } from "@platos/context-secrets/application/ports/index.js";
import { asSecretsIdentifier } from "@platos/context-secrets/application/ports/index.js";
import type { CredentialId } from "@platos/context-secrets/application/ports/index.js";

import { createEnvelopeCipher } from "./envelope-cipher.js";
import { createRootKeyRing } from "./root-key-ring.js";
import type { WireVector } from "./wire-vectors.js";
import { WIRE_VECTORS, hexBytes } from "./wire-vectors.js";

function bindingOf(vector: WireVector): EnvelopeBinding {
  return {
    environmentId: asSecretsIdentifier(vector.environmentId),
    credentialId: asSecretsIdentifier<CredentialId>(vector.credentialId),
    secretRevision: vector.secretRevision as SecretRevision,
    formatVersion: 1,
    rootKeyVersion: vector.rootKeyVersion as RootKeyVersion,
  };
}

function ringFor(vector: WireVector) {
  const ring = createRootKeyRing({
    activeVersion: vector.rootKeyVersion,
    keys: { [String(vector.rootKeyVersion)]: vector.rootKeyHex },
  });
  if (!ring.ok) throw new Error(`ring did not build: ${ring.error.code}`);
  return ring.value;
}

function handleFor(vector: WireVector) {
  const ring = ringFor(vector);
  const handle = ring.mint(vector.rootKeyVersion as RootKeyVersion);
  if (!handle.ok) throw new Error(`handle did not mint: ${handle.error.code}`);
  return { ring, handle: handle.value };
}

describe("format 1 wire compatibility with the extraction source", () => {
  for (const vector of WIRE_VECTORS) {
    it(`opens an envelope the extraction source sealed: ${vector.name}`, async () => {
      const { ring, handle } = handleFor(vector);
      const opened = await createEnvelopeCipher(ring).open({
        key: handle,
        binding: bindingOf(vector),
        envelope: {
          salt: hexBytes(vector.saltHex),
          nonce: hexBytes(vector.nonceHex),
          ciphertext: hexBytes(vector.ciphertextHex),
          authTag: hexBytes(vector.authTagHex),
        },
      });

      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.value.reveal()).toBe(vector.plaintext);
    });
  }

  // The negative control for the three above. Without it, an `open` that ignored
  // its binding entirely would pass every positive case — the associated data
  // would simply never be checked, and no vector could tell.
  it("refuses a vector whose binding names another credential", async () => {
    const vector = WIRE_VECTORS[0] as WireVector;
    const { ring, handle } = handleFor(vector);
    const opened = await createEnvelopeCipher(ring).open({
      key: handle,
      binding: {
        ...bindingOf(vector),
        credentialId: asSecretsIdentifier<CredentialId>("00000000-0000-4000-8000-000000000000"),
      },
      envelope: {
        salt: hexBytes(vector.saltHex),
        nonce: hexBytes(vector.nonceHex),
        ciphertext: hexBytes(vector.ciphertextHex),
        authTag: hexBytes(vector.authTagHex),
      },
    });

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.code).toBe("CREDENTIAL_UNAVAILABLE");
  });

  // The SECOND negative control, and the one the whole rotation story rests on.
  // The revision is inside both the derived key and the associated data, so a
  // re-encryption that wrote the wrong revision would produce a row nothing can
  // ever open. Vector two is at revision 7; opening it as revision 1 must fail.
  it("refuses a vector whose binding names another revision", async () => {
    const vector = WIRE_VECTORS[1] as WireVector;
    const { ring, handle } = handleFor(vector);
    const opened = await createEnvelopeCipher(ring).open({
      key: handle,
      binding: { ...bindingOf(vector), secretRevision: 1 as SecretRevision },
      envelope: {
        salt: hexBytes(vector.saltHex),
        nonce: hexBytes(vector.nonceHex),
        ciphertext: hexBytes(vector.ciphertextHex),
        authTag: hexBytes(vector.authTagHex),
      },
    });

    expect(opened.ok).toBe(false);
  });

  // Round trip in the other direction: what this adapter SEALS must be openable
  // with the same primitives the extraction source uses. The vectors prove the
  // read side; this proves the write side is the same format rather than a
  // second one that happens to be self-consistent.
  it("seals an envelope this adapter can re-open at the same binding", async () => {
    const vector = WIRE_VECTORS[0] as WireVector;
    const { ring, handle } = handleFor(vector);
    const cipher = createEnvelopeCipher(ring);
    const binding = bindingOf(vector);

    const sealed = await cipher.seal({
      key: handle,
      binding,
      plaintext: { reveal: () => vector.plaintext, toJSON: () => "x", toString: () => "x" },
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;

    // Widths are format 1's descriptor, and they are asserted because the
    // extraction source's rows carry exactly these and a narrower nonce would
    // still round-trip inside this adapter.
    expect(sealed.value.salt).toHaveLength(32);
    expect(sealed.value.nonce).toHaveLength(12);
    expect(sealed.value.authTag).toHaveLength(16);

    const opened = await cipher.open({ key: handle, binding, envelope: sealed.value });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.reveal()).toBe(vector.plaintext);
  });

  it("draws a fresh salt and nonce for every seal", async () => {
    const vector = WIRE_VECTORS[0] as WireVector;
    const { ring, handle } = handleFor(vector);
    const cipher = createEnvelopeCipher(ring);
    const binding = bindingOf(vector);
    const material = { reveal: () => "same-plaintext", toJSON: () => "x", toString: () => "x" };

    const first = await cipher.seal({ key: handle, binding, plaintext: material });
    const second = await cipher.seal({ key: handle, binding, plaintext: material });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // A reused GCM nonce under one key is a total break, and the port says the
    // cipher owns randomness so no caller can supply one.
    expect(Buffer.from(first.value.nonce).toString("hex")).not.toBe(
      Buffer.from(second.value.nonce).toString("hex"),
    );
    expect(Buffer.from(first.value.salt).toString("hex")).not.toBe(
      Buffer.from(second.value.salt).toString("hex"),
    );
    expect(Buffer.from(first.value.ciphertext).toString("hex")).not.toBe(
      Buffer.from(second.value.ciphertext).toString("hex"),
    );
  });
});
