// Does this adapter speak the format every stored envelope was written in?
//
// The three vectors it opens were produced by
// `internal-packages/tenancy-database/src/secrets.ts`, which this issue does not
// edit. That is the whole design of the file: an assertion comparing this
// adapter's `envelopeAad` against the domain's `envelopeAad` compares two things
// one tranche controls, so a mutation that changed the domain constant would move
// both sides and stay green. A ciphertext moves with neither.

import { describe, expect, it } from "vitest";

import type { EnvelopeBinding, EnvironmentId, RootKeyVersion, SecretRevision } from "@platos/context-secrets/application/ports/index.js";
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

/**
 * Open one vector, or report why not.
 *
 * A HELPER AND NOT A LOOP OVER `it()`, deliberately.
 * `scripts/arch/test-case-census.mjs` refuses an `it()` declared inside a loop —
 * "a construct it cannot count is a construct that can silently lose a case" —
 * so each vector gets its own named case below and the shared body lives here.
 */
async function openVector(vector: WireVector) {
  const { ring, handle } = handleFor(vector);
  return createEnvelopeCipher(ring).open({
    key: handle,
    binding: bindingOf(vector),
    envelope: {
      salt: hexBytes(vector.saltHex),
      nonce: hexBytes(vector.nonceHex),
      ciphertext: hexBytes(vector.ciphertextHex),
      authTag: hexBytes(vector.authTagHex),
    },
  });
}

function vectorAt(index: number): WireVector {
  const vector = WIRE_VECTORS[index];
  if (vector === undefined) throw new Error(`wire vector ${index} is missing`);
  return vector;
}

describe("format 1 wire compatibility with the extraction source", () => {
  it("opens the extraction source's revision 1 envelope under root key version 1", async () => {
    const vector = vectorAt(0);
    const opened = await openVector(vector);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.reveal()).toBe(vector.plaintext);
  });

  it("opens its revision 7 envelope under root key version 2", async () => {
    // The SAME key bytes as version 1, at a different revision and version. Both
    // fields are inside the derived key and the associated data, so this case
    // fails the moment either stops reaching the binding.
    const vector = vectorAt(1);
    const opened = await openVector(vector);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.reveal()).toBe(vector.plaintext);
  });

  it("opens its non-ASCII envelope under a third root key", async () => {
    const vector = vectorAt(2);
    const opened = await openVector(vector);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.reveal()).toBe(vector.plaintext);
  });

  // The negative control for the three above. Without it, an `open` that ignored
  // its binding entirely would pass every positive case — the associated data
  // would simply never be checked, and no vector could tell.
  it("refuses a vector whose binding names another credential", async () => {
    const vector = vectorAt(0);
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
    const vector = vectorAt(1);
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
    const vector = vectorAt(0);
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

  // FOUND BY A SURVIVING MUTANT. Changing `cipher.update(plaintext, "utf8")` to
  // `"latin1"` on the SEAL side survived every case above, because the three
  // non-ASCII bytes in the tree were only ever OPENED — vector three is a fixture
  // this adapter reads and never writes, and every plaintext it seals was ASCII,
  // where the two encodings agree byte for byte. So the write side's encoding was
  // untested, and a mis-encoded seal is silent: it round-trips inside a process
  // that makes the same mistake twice and produces mojibake the day anything else
  // reads the row.
  it("seals and re-opens multi-byte UTF-8, a newline and a tab", async () => {
    const vector = vectorAt(2);
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

    // The ciphertext is as long as the UTF-8 ENCODING, not as long as the string.
    // GCM is a stream cipher, so `ciphertext.length` is exactly the byte count —
    // which is what says the seal encoded 8 characters of `éàü` as more than 8
    // bytes rather than truncating each to one.
    expect(sealed.value.ciphertext).toHaveLength(Buffer.byteLength(vector.plaintext, "utf8"));
    expect(sealed.value.ciphertext.length).toBeGreaterThan(vector.plaintext.length);

    const opened = await cipher.open({ key: handle, binding, envelope: sealed.value });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.reveal()).toBe(vector.plaintext);
  });

  it("draws a fresh salt and nonce for every seal", async () => {
    const vector = vectorAt(0);
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

// M2 INTEGRATION — THE SECRET REFERENCE, AT A REAL CIPHER FOR THE FIRST TIME.
//
// The projection dimension built `sealHandle`/`openHandle` and measured, truly,
// that "no production AeadCipher adapter exists": its twenty-six exchange cases
// run against `inMemoryAeadCipher`, whose own header says it is not
// cryptography. The lifecycle dimension then built the production adapter.
// Composed, the reference's claims can be settled by AES-256-GCM, and the two
// that could NOT be settled by a double are settled here.
//
// EVERY CASE JOINS TO SOMETHING THIS FILE DOES NOT CONTROL. The environments,
// the root keys and the versions are `wire-vectors.ts`'s, produced for the
// ENVELOPE format by the extraction source; the labels are the domain's
// `secretHandleKeyInfo`/`secretHandleAad`, imported and never re-typed; and the
// refusals are produced by the GCM tag check rather than by any comparison in
// `envelope-cipher.ts`.
describe("the SECRET REFERENCE seals and opens under real AES-256-GCM", () => {
  const BODY = "hnd_0000000000000000000000001 8a0f6d4e-1b23-4c56-9a7b-0d1e2f3a4b5c 1";

  function handleBinding(vector: WireVector) {
    return {
      environmentId: asSecretsIdentifier<EnvironmentId>(vector.environmentId),
      rootKeyVersion: vector.rootKeyVersion as RootKeyVersion,
    };
  }

  it("returns the claims body byte for byte after a round trip", async () => {
    const vector = vectorAt(0);
    const { ring, handle } = handleFor(vector);
    const cipher = createEnvelopeCipher(ring);
    const binding = handleBinding(vector);

    const sealed = await cipher.sealHandle({ key: handle, binding, body: BODY });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    // The ciphertext is exactly as long as the body's UTF-8 encoding, which is
    // what says GCM streamed it rather than padded it. It does NOT catch an
    // encoding change: a claims body is a handle id, a UUID, a revision and two
    // ISO instants, so it is ASCII by construction and latin1 and utf8 agree on
    // it. That is measured (M-G below in the ledger), not assumed.
    expect(sealed.value.ciphertext).toHaveLength(Buffer.byteLength(BODY, "utf8"));

    const opened = await cipher.openHandle({ key: handle, binding, envelope: sealed.value });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value).toBe(BODY);
  });

  it("does not open under ANOTHER environment, and fails at the tag rather than at a comparison", async () => {
    const mine = vectorAt(0);
    const theirs = vectorAt(2);
    const { ring, handle } = handleFor(mine);
    const cipher = createEnvelopeCipher(ring);

    const sealed = await cipher.sealHandle({ key: handle, binding: handleBinding(mine), body: BODY });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;

    // The environments differ and NOTHING else does: the same ring, the same
    // handle, the same root key version, the same bytes. The foreign
    // environment id is the third vector's, which this file did not invent.
    expect(theirs.environmentId).not.toBe(mine.environmentId);
    const foreign = await cipher.openHandle({
      key: handle,
      binding: {
        environmentId: asSecretsIdentifier<EnvironmentId>(theirs.environmentId),
        rootKeyVersion: handleBinding(mine).rootKeyVersion,
      },
      envelope: sealed.value,
    });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error.code).toBe("CREDENTIAL_UNAVAILABLE");
  });

  it("REFUSES a credential envelope presented as a reference, because the two label spaces cannot collide", async () => {
    const vector = vectorAt(0);
    const { ring, handle } = handleFor(vector);
    const cipher = createEnvelopeCipher(ring);

    // A real format-1 envelope, sealed by `seal` over the CREDENTIAL label space.
    const envelope = await cipher.seal({
      key: handle,
      binding: bindingOf(vector),
      plaintext: { reveal: () => vector.plaintext, toJSON: () => "x", toString: () => "x" },
    });
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;

    // Handed to `openHandle` under the same ring, the same version and the same
    // environment. This is the claim `crypto.ts` makes in prose — "what makes a
    // reference safe is that `secretHandleAad` and `envelopeAad` can never
    // collide" — and until a real cipher existed nothing could settle it.
    const opened = await cipher.openHandle({
      key: handle,
      binding: handleBinding(vector),
      envelope: envelope.value,
    });
    expect(opened.ok).toBe(false);
  });

  it("does not open under another ROOT KEY VERSION of the same ring", async () => {
    const vector = vectorAt(0);
    const ring = createRootKeyRing({
      activeVersion: 1,
      // Two versions, DIFFERENT bytes, one ring — the shape an installation is
      // in mid-rotation, and the one a single-key configuration cannot express.
      keys: { "1": vector.rootKeyHex, "2": vectorAt(2).rootKeyHex },
    });
    expect(ring.ok).toBe(true);
    if (!ring.ok) return;
    const cipher = createEnvelopeCipher(ring.value);
    const first = ring.value.mint(1 as RootKeyVersion);
    const second = ring.value.mint(2 as RootKeyVersion);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const sealed = await cipher.sealHandle({
      key: first.value,
      binding: {
        environmentId: asSecretsIdentifier<EnvironmentId>(vector.environmentId),
        rootKeyVersion: 1 as RootKeyVersion,
      },
      body: BODY,
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;

    const opened = await cipher.openHandle({
      key: second.value,
      binding: {
        environmentId: asSecretsIdentifier<EnvironmentId>(vector.environmentId),
        rootKeyVersion: 2 as RootKeyVersion,
      },
      envelope: sealed.value,
    });
    expect(opened.ok).toBe(false);
  });

  it("draws a fresh salt and nonce for every reference it seals", async () => {
    const vector = vectorAt(0);
    const { ring, handle } = handleFor(vector);
    const cipher = createEnvelopeCipher(ring);
    const binding = handleBinding(vector);

    const first = await cipher.sealHandle({ key: handle, binding, body: BODY });
    const second = await cipher.sealHandle({ key: handle, binding, body: BODY });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // Two references to the SAME credential at the SAME revision are two
    // different ciphertexts, so holding one says nothing about another.
    expect(Buffer.from(first.value.nonce).toString("hex")).not.toBe(
      Buffer.from(second.value.nonce).toString("hex"),
    );
    expect(Buffer.from(first.value.ciphertext).toString("hex")).not.toBe(
      Buffer.from(second.value.ciphertext).toString("hex"),
    );
  });
});
