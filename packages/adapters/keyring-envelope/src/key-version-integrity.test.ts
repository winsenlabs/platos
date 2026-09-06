// WIN-259's central claim, stated as four properties over one rotation.
//
//   1. A row written under key v1 is STILL READABLE after rotating to v2.
//   2. v1 material CANNOT silently decrypt a v2 row, and vice versa.
//   3. After re-encryption the row opens under v2 and v1 can be REMOVED.
//   4. Removing v1 before re-encryption makes the row unreadable rather than
//      readable-by-something-else. That is the fail-closed half, and it is the
//      half that makes property 1 worth anything.
//
// WHY THESE ARE HERE AND NOT ONLY IN `secrets`. Every rotation rule in that
// context is already proven — against `in-memory-crypto.ts`, whose header says
// "It is NOT cryptography." A keystream derived from FNV-1a would satisfy all
// four properties by construction, because the fake key material is the string
// `root-key-material-${version}` and a wrong version obviously produces a wrong
// keystream. Under real AES-256-GCM the four are properties of HKDF, of the
// associated data and of the tag, and nothing about them is obvious.

import { describe, expect, it } from "vitest";

import type {
  CredentialId,
  EnvelopeBinding,
  EnvironmentId,
  RootKeyVersion,
  SealedEnvelope,
  SecretMaterial,
  SecretRevision,
} from "@platos/context-secrets/application/ports/index.js";
import { asSecretsIdentifier } from "@platos/context-secrets/application/ports/index.js";

import { createEnvelopeCipher } from "./envelope-cipher.js";
import type { RootKeyRingResolver } from "./root-key-ring.js";
import { createRootKeyRing } from "./root-key-ring.js";

const KEY_V1 = "11".repeat(32);
const KEY_V2 = "22".repeat(32);

const ENVIRONMENT = asSecretsIdentifier<EnvironmentId>("env_00000000000000000000000rot");
const CREDENTIAL = asSecretsIdentifier<CredentialId>("6b1f0c33-9a2e-4d81-b7c5-0f2e4a6c8d10");

const PLAINTEXT = "sk-live-rotated-under-two-root-keys";

function material(value: string): SecretMaterial {
  return { reveal: () => value, toJSON: () => "x", toString: () => "x" };
}

function binding(rootKeyVersion: number, secretRevision = 1): EnvelopeBinding {
  return {
    environmentId: ENVIRONMENT,
    credentialId: CREDENTIAL,
    secretRevision: secretRevision as SecretRevision,
    formatVersion: 1,
    rootKeyVersion: rootKeyVersion as RootKeyVersion,
  };
}

function ring(activeVersion: number, keys: Readonly<Record<string, string>>): RootKeyRingResolver {
  const built = createRootKeyRing({ activeVersion, keys });
  if (!built.ok) throw new Error(`ring did not build: ${built.error.code}`);
  return built.value;
}

async function sealUnder(
  resolver: RootKeyRingResolver,
  rootKeyVersion: number,
  plaintext: string,
  secretRevision = 1,
): Promise<SealedEnvelope> {
  const handle = resolver.mint(rootKeyVersion as RootKeyVersion);
  if (!handle.ok) throw new Error(`handle did not mint: ${handle.error.code}`);
  const sealed = await createEnvelopeCipher(resolver).seal({
    key: handle.value,
    binding: binding(rootKeyVersion, secretRevision),
    plaintext: material(plaintext),
  });
  if (!sealed.ok) throw new Error(`seal failed: ${sealed.error.code}`);
  return sealed.value;
}

/** The BEFORE state: one key, one envelope, sealed under version 1. */
async function beforeRotation(): Promise<SealedEnvelope> {
  return sealUnder(ring(1, { "1": KEY_V1 }), 1, PLAINTEXT);
}

describe("a rotation does not lose what the previous key sealed", () => {
  it("opens a v1 envelope after the ring has rotated to v2", async () => {
    const envelope = await beforeRotation();

    // The rotation: v2 is added and becomes active, v1 STAYS in the ring. That
    // retention is what `domain/key-ring.ts` calls the `prior` status, and it is
    // the whole reason a re-encryption is owed rather than required instantly.
    const rotated = ring(2, { "1": KEY_V1, "2": KEY_V2 });
    const state = rotated.state();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.activeVersion).toBe(2);

    const handle = rotated.mint(1 as RootKeyVersion);
    expect(handle.ok).toBe(true);
    if (!handle.ok) return;

    const opened = await createEnvelopeCipher(rotated).open({
      key: handle.value,
      binding: binding(1),
      envelope,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.reveal()).toBe(PLAINTEXT);
  });

  it("re-encrypts the same revision onto v2 and opens it under v2", async () => {
    const envelope = await beforeRotation();
    const rotated = ring(2, { "1": KEY_V1, "2": KEY_V2 });
    const cipher = createEnvelopeCipher(rotated);

    const priorHandle = rotated.mint(1 as RootKeyVersion);
    if (!priorHandle.ok) throw new Error("prior handle");
    const opened = await cipher.open({ key: priorHandle.value, binding: binding(1), envelope });
    if (!opened.ok) throw new Error("prior open");

    // The REVISION does not advance — the material is unchanged. Only the root
    // key version moves, which is exactly what makes the store's
    // [credentialId, secretRevision, rootKeyVersion] key a legal second row.
    const activeHandle = rotated.mint(2 as RootKeyVersion);
    if (!activeHandle.ok) throw new Error("active handle");
    const resealed = await cipher.seal({
      key: activeHandle.value,
      binding: binding(2),
      plaintext: opened.value,
    });
    expect(resealed.ok).toBe(true);
    if (!resealed.ok) return;

    // AFTER re-encryption v1 may leave the ring, and the row still opens. This is
    // the state `canRemoveRootKey` calls removable, proven on the bytes.
    const withoutV1 = ring(2, { "2": KEY_V2 });
    const finalHandle = withoutV1.mint(2 as RootKeyVersion);
    if (!finalHandle.ok) throw new Error("final handle");
    const reopened = await createEnvelopeCipher(withoutV1).open({
      key: finalHandle.value,
      binding: binding(2),
      envelope: resealed.value,
    });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.value.reveal()).toBe(PLAINTEXT);
  });
});

describe("one key version cannot silently open another's envelope", () => {
  it("refuses to open a v1 envelope with v2 material", async () => {
    const envelope = await beforeRotation();
    const rotated = ring(2, { "1": KEY_V1, "2": KEY_V2 });

    // The binding still says v1, so the associated data is right and only the
    // KEY is wrong. That is the narrowest form of the question: does the version
    // actually select different material, or is the binding carrying the whole
    // difference?
    const wrongKey = rotated.mint(2 as RootKeyVersion);
    if (!wrongKey.ok) throw new Error("handle");
    const opened = await createEnvelopeCipher(rotated).open({
      key: wrongKey.value,
      binding: binding(1),
      envelope,
    });

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    // The handle and the binding disagree, and that disagreement is refused
    // BEFORE the cipher, because a seal under it would write an envelope nothing
    // could ever open. `open` refuses it for symmetry: the same request shape is
    // wrong in both directions.
    expect(opened.error.code).toBe("INVALID_KEY_RING");
    expect(opened.error.details["reason"]).toBe("root_key_handle_disagrees_with_envelope_binding");
  });

  it("refuses to open a v1 envelope re-labelled as v2, with the v2 key", async () => {
    const envelope = await beforeRotation();
    const rotated = ring(2, { "1": KEY_V1, "2": KEY_V2 });

    // The lie an attacker or a buggy migration would tell: claim the row is a v2
    // row and hand the v2 key. Handle and binding now AGREE, so the guard above
    // does not fire and the tag check has to catch it. It does, because
    // `rootKeyVersion` is inside both the HKDF info and the associated data.
    const handle = rotated.mint(2 as RootKeyVersion);
    if (!handle.ok) throw new Error("handle");
    const opened = await createEnvelopeCipher(rotated).open({
      key: handle.value,
      binding: binding(2),
      envelope,
    });

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.code).toBe("CREDENTIAL_UNAVAILABLE");
    expect(opened.error.details["reason"]).toBe("envelope_open_failed");
  });

  it("refuses a seal whose handle names a different version than its binding", async () => {
    // The silent-data-loss case, and the reason the guard is on the WRITE path at
    // all. Sealing with the v2 key under a v1 binding succeeds in raw GCM and
    // produces a row `open` can never recover: `open` derives from the BINDING,
    // so it would reach for v1's material forever.
    const rotated = ring(2, { "1": KEY_V1, "2": KEY_V2 });
    const handle = rotated.mint(2 as RootKeyVersion);
    if (!handle.ok) throw new Error("handle");

    const sealed = await createEnvelopeCipher(rotated).seal({
      key: handle.value,
      binding: binding(1),
      plaintext: material(PLAINTEXT),
    });

    expect(sealed.ok).toBe(false);
    if (sealed.ok) return;
    expect(sealed.error.code).toBe("INVALID_KEY_RING");
    expect(sealed.error.details["reason"]).toBe("root_key_handle_disagrees_with_envelope_binding");
  });
});

describe("a key removed before its envelopes were re-encrypted fails closed", () => {
  it("cannot mint a handle for a version that has left the ring", async () => {
    await beforeRotation();
    const pruned = ring(2, { "2": KEY_V2 });

    const handle = pruned.mint(1 as RootKeyVersion);
    expect(handle.ok).toBe(false);
    if (handle.ok) return;
    expect(handle.error.details["reason"]).toBe("root_key_version_absent_from_ring");
  });

  it("answers an unreadable v1 row with a refusal and never with ciphertext", async () => {
    const envelope = await beforeRotation();
    const pruned = ring(2, { "2": KEY_V2 });

    // The only handle obtainable now is v2's, and the row is v1's. Both routes
    // to reading it are closed: the disagreement guard on a v1 binding, and the
    // tag check on a v2 binding. Neither returns bytes.
    const handle = pruned.mint(2 as RootKeyVersion);
    if (!handle.ok) throw new Error("handle");
    const cipher = createEnvelopeCipher(pruned);

    const asV1 = await cipher.open({ key: handle.value, binding: binding(1), envelope });
    const asV2 = await cipher.open({ key: handle.value, binding: binding(2), envelope });

    expect(asV1.ok).toBe(false);
    expect(asV2.ok).toBe(false);
    if (asV1.ok || asV2.ok) return;
    // TWO refusals, TWO codes. They are different failures — a request that
    // cannot be honoured, and a request that was honoured and did not
    // authenticate — and collapsing them would hide the first behind the second.
    expect(asV1.error.code).toBe("INVALID_KEY_RING");
    expect(asV2.error.code).toBe("CREDENTIAL_UNAVAILABLE");
  });
});

describe("an envelope is bound to its row and to nothing else", () => {
  it("refuses an envelope moved to another environment", async () => {
    const envelope = await beforeRotation();
    const resolver = ring(1, { "1": KEY_V1 });
    const handle = resolver.mint(1 as RootKeyVersion);
    if (!handle.ok) throw new Error("handle");

    const opened = await createEnvelopeCipher(resolver).open({
      key: handle.value,
      binding: { ...binding(1), environmentId: asSecretsIdentifier<EnvironmentId>("env_00000000000000000000000oth") },
      envelope,
    });
    expect(opened.ok).toBe(false);
  });

  it("refuses an envelope whose ciphertext has one flipped bit", async () => {
    const envelope = await beforeRotation();
    const resolver = ring(1, { "1": KEY_V1 });
    const handle = resolver.mint(1 as RootKeyVersion);
    if (!handle.ok) throw new Error("handle");

    const tampered = new Uint8Array(envelope.ciphertext);
    tampered[0] = (tampered[0] as number) ^ 0x01;

    const opened = await createEnvelopeCipher(resolver).open({
      key: handle.value,
      binding: binding(1),
      envelope: { ...envelope, ciphertext: tampered },
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.code).toBe("CREDENTIAL_UNAVAILABLE");
  });

  it("refuses an envelope whose auth tag has one flipped bit", async () => {
    const envelope = await beforeRotation();
    const resolver = ring(1, { "1": KEY_V1 });
    const handle = resolver.mint(1 as RootKeyVersion);
    if (!handle.ok) throw new Error("handle");

    const tampered = new Uint8Array(envelope.authTag);
    tampered[15] = (tampered[15] as number) ^ 0x80;

    const opened = await createEnvelopeCipher(resolver).open({
      key: handle.value,
      binding: binding(1),
      envelope: { ...envelope, authTag: tampered },
    });
    expect(opened.ok).toBe(false);
  });

  it("refuses an envelope whose salt has one flipped bit", async () => {
    // The salt is the HKDF extract salt, so a flipped bit derives a different
    // per-envelope key. It is unauthenticated on its own — GCM never sees it —
    // which is exactly why this case is asserted rather than assumed.
    const envelope = await beforeRotation();
    const resolver = ring(1, { "1": KEY_V1 });
    const handle = resolver.mint(1 as RootKeyVersion);
    if (!handle.ok) throw new Error("handle");

    const tampered = new Uint8Array(envelope.salt);
    tampered[31] = (tampered[31] as number) ^ 0x40;

    const opened = await createEnvelopeCipher(resolver).open({
      key: handle.value,
      binding: binding(1),
      envelope: { ...envelope, salt: tampered },
    });
    expect(opened.ok).toBe(false);
  });

  it("refuses a nonce of the wrong width without throwing out of the port", async () => {
    // `createDecipheriv` THROWS on a 4-byte GCM nonce. A throw crossing a port
    // boundary is a defect, so the catch has to be wide enough to hold it.
    const envelope = await beforeRotation();
    const resolver = ring(1, { "1": KEY_V1 });
    const handle = resolver.mint(1 as RootKeyVersion);
    if (!handle.ok) throw new Error("handle");

    const opened = await createEnvelopeCipher(resolver).open({
      key: handle.value,
      binding: binding(1),
      envelope: { ...envelope, nonce: new Uint8Array([1, 2, 3, 4]) },
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.code).toBe("CREDENTIAL_UNAVAILABLE");
  });

  it("refuses an envelope moved to another revision of the same credential", async () => {
    const envelope = await beforeRotation();
    const resolver = ring(1, { "1": KEY_V1 });
    const handle = resolver.mint(1 as RootKeyVersion);
    if (!handle.ok) throw new Error("handle");

    const opened = await createEnvelopeCipher(resolver).open({
      key: handle.value,
      binding: binding(1, 2),
      envelope,
    });
    expect(opened.ok).toBe(false);
  });
});
