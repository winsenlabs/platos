// WIN-259 M2.4. Does a REAL PostgreSQL give back the exact envelope bytes a real
// cipher sealed, across a root key rotation?
//
// WHY THE BYTES ARE FIXTURES AND NOT SEALED HERE. The joint proof — real rows AND
// real AES-256-GCM in one process — has no legal home. `adapter-is-self-contained`
// forbids this directory from importing `@platos/adapter-keyring-envelope`, and
// `tenancy-prisma-only` forbids that adapter from importing the ORM. The
// composition root may name both and exports neither's harness. So the chain is
// proven in two halves that meet on the SAME frozen bytes:
//
//   `keyring-envelope/src/wire-compatibility.test.ts` proves these exact
//   ciphertexts, under these exact bindings, open to these exact plaintexts.
//   THIS suite proves PostgreSQL stores and returns them unchanged.
//
// The bytes themselves came from `internal-packages/tenancy-database`'s
// `encryptCredentialSecret`, which neither half owns. A store that truncated a
// `Bytes` column, re-encoded it, dropped a trailing NUL or swapped the salt and
// the nonce would make every one of those envelopes permanently unopenable — and
// nothing in the crypto suite, which never touches a database, could tell.
//
// WHAT ELSE THIS SUITE IS FOR. `[credentialId, secretRevision, rootKeyVersion]`
// is the unique key that makes re-encryption a legal SECOND row at the same
// revision. Every other suite in this directory exercises it with
// `bytes(32, fill)` — thirty-two identical bytes — which is a width and not an
// envelope. Here the two rows of a real re-encryption carry two real, different
// ciphertexts of the same plaintext, and the constraint is asked the question it
// exists to answer.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EnvironmentId } from "@platos/context-tenancy/application/ports/index.js";

import type { SecretsHarness } from "./secrets-harness.js";
import {
  AT,
  LATER,
  credentialDraft,
  credentialIdOf,
  revisionOf,
  rootKeyOf,
  startSecretsHarness,
  versionIdOf,
} from "./secrets-harness.js";

// ---------------------------------------------------------------------------
// The frozen envelopes, byte-identical to
// `packages/adapters/keyring-envelope/src/wire-vectors.ts`.
//
// They are RE-DECLARED rather than imported, and that is the boundary rule
// rather than a preference: this directory may not import that package. The
// duplication is deliberate and is what a reader must check by eye — which is
// why each vector below names the entry it mirrors.
// ---------------------------------------------------------------------------

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** `wire-vectors.ts` entry 1 — "revision 1 under root key version 1". */
const ENVELOPE_V1 = Object.freeze({
  salt: hexBytes("4156adb01a5fcea3740baa0ad7f7a71a7d12c3b26d6adc47456bd5a4c7bf354e"),
  nonce: hexBytes("48aed6447cc6228ec6ad4e60"),
  ciphertext: hexBytes("b9fdb625db0bbb6d8c712d3fe9dca9ab902a42f539907c499e"),
  authTag: hexBytes("1e21582d35d0be31c4e680f0ae6a07d8"),
});

/** `wire-vectors.ts` entry 2 — "revision 7 under root key version 2". */
const ENVELOPE_V2 = Object.freeze({
  salt: hexBytes("cd80e8354304982a320a74aabc08695cb596ab9c1f58b0cd4b3eaabce3ecedd3"),
  nonce: hexBytes("b83d2b0ec82116cecb53f116"),
  ciphertext: hexBytes("609d5e9ff8608063ee9c0bdea0a5d460326abf9bf484ec285b275909329e668a79"),
  authTag: hexBytes("1975693bf141525ba9f9b60cb9117ad2"),
});

/** `wire-vectors.ts` entry 3 — non-ASCII plaintext, a 35-byte ciphertext. */
const ENVELOPE_V9 = Object.freeze({
  salt: hexBytes("b57cd65512eb6f5756bede4ae0ccc56529a5be0878ea10766641092e8c75df11"),
  nonce: hexBytes("a4950246ae3a982002128588"),
  ciphertext: hexBytes("f571c9e9d97b6369fcbc2d820291d09a8c0d937e8781a896094c37c26d176da7f54177"),
  authTag: hexBytes("a7b9ce744105db6a6471380c01f5e8fd"),
});

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

let harness: SecretsHarness;
let environmentId: EnvironmentId;

beforeAll(async () => {
  harness = await startSecretsHarness();
  environmentId = await harness.freshEnvironment();
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

async function seedCredential(id: string, name: string): Promise<void> {
  const written = await harness.base.adapter.unitOfWork.run((transaction) =>
    harness.repository.insertCredential(
      credentialDraft({ id, environmentId, kind: "SERVICE_CREDENTIAL", name, provider: "openai" }),
      transaction,
    ),
  );
  expect(written.ok).toBe(true);
}

describe("a real envelope survives a real PostgreSQL round trip", () => {
  it("returns every byte of a format-1 envelope unchanged", async () => {
    const credentialId = "aa000000-0000-4000-8000-00000000e001";
    const versionId = "bb000000-0000-4000-8000-00000000e001";
    await seedCredential(credentialId, "round-trip-v1");

    const stored = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertSecretVersion(
        {
          id: versionIdOf(versionId),
          credentialId: credentialIdOf(credentialId),
          secretRevision: revisionOf(1),
          formatVersion: 1,
          rootKeyVersion: rootKeyOf(1),
          ...ENVELOPE_V1,
          createdAt: AT,
        },
        transaction,
      ),
    );
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;

    // The INSERT's own return value first. A store that mangled on the way in
    // and un-mangled on the way out would still be wrong, and comparing only the
    // read-back would miss it.
    expect(hex(stored.value.salt)).toBe(hex(ENVELOPE_V1.salt));
    expect(hex(stored.value.nonce)).toBe(hex(ENVELOPE_V1.nonce));
    expect(hex(stored.value.ciphertext)).toBe(hex(ENVELOPE_V1.ciphertext));
    expect(hex(stored.value.authTag)).toBe(hex(ENVELOPE_V1.authTag));

    await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.setActiveSecretVersion(
        credentialIdOf(credentialId),
        versionIdOf(versionId),
        AT,
        transaction,
      ),
    );

    const read = await harness.repository.findCredential({ environmentId, credentialId: credentialIdOf(credentialId) });
    expect(read.ok).toBe(true);
    if (!read.ok || read.value === null || read.value.activeSecretVersion === null) {
      expect.unreachable("the credential and its active envelope must both come back");
      return;
    }
    const version = read.value.activeSecretVersion;

    // THE ASSERTION THAT MATTERS. These are the bytes
    // `keyring-envelope/src/wire-compatibility.test.ts` opens to
    // "sk-live-win259-vector-one". One flipped bit here and that plaintext is
    // gone forever, and nothing else in this repository would notice.
    expect(hex(version.salt)).toBe("4156adb01a5fcea3740baa0ad7f7a71a7d12c3b26d6adc47456bd5a4c7bf354e");
    expect(hex(version.nonce)).toBe("48aed6447cc6228ec6ad4e60");
    expect(hex(version.ciphertext)).toBe("b9fdb625db0bbb6d8c712d3fe9dca9ab902a42f539907c499e");
    expect(hex(version.authTag)).toBe("1e21582d35d0be31c4e680f0ae6a07d8");

    // Widths, separately from contents. A column that padded to a fixed width
    // would still compare equal in hex only if the padding were also compared,
    // and `toHaveLength` is what says the ciphertext is 25 bytes and not 25
    // bytes of a 32-byte field.
    expect(version.ciphertext).toHaveLength(25);
    expect(version.salt).toHaveLength(32);
    expect(version.nonce).toHaveLength(12);
    expect(version.authTag).toHaveLength(16);

    // And the KEY VERSION came back as the integer it was written as. It is
    // inside the HKDF info and the associated data, so a store that widened,
    // defaulted or dropped it produces a row that cannot be opened even though
    // every byte of ciphertext survived.
    expect(version.rootKeyVersion).toBe(1);
    expect(version.secretRevision).toBe(1);
    expect(version.formatVersion).toBe(1);
  });

  it("stores a 35-byte ciphertext beside a 25-byte one without padding either", async () => {
    // Two real ciphertexts of different lengths in the same column. A `Bytes`
    // column that padded, or a decoder that assumed a width, is caught by the
    // pair rather than by either row alone.
    const credentialId = "aa000000-0000-4000-8000-00000000e009";
    const versionId = "bb000000-0000-4000-8000-00000000e009";
    await seedCredential(credentialId, "round-trip-v9");

    const stored = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertSecretVersion(
        {
          id: versionIdOf(versionId),
          credentialId: credentialIdOf(credentialId),
          secretRevision: revisionOf(1),
          formatVersion: 1,
          rootKeyVersion: rootKeyOf(9),
          ...ENVELOPE_V9,
          createdAt: AT,
        },
        transaction,
      ),
    );
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;

    expect(stored.value.ciphertext).toHaveLength(35);
    expect(hex(stored.value.ciphertext)).toBe(
      "f571c9e9d97b6369fcbc2d820291d09a8c0d937e8781a896094c37c26d176da7f54177",
    );
    // A NINE, not a one. `rootKeyVersion` is a plain `Int` with no default and no
    // CHECK, and every other suite in this directory writes 1 or 2.
    expect(stored.value.rootKeyVersion).toBe(9);
  });
});

describe("a rotation and a re-encryption are two different rows", () => {
  it("holds the same revision under two root key versions, each with its own bytes", async () => {
    // THE RE-ENCRYPTION SHAPE. `[credentialId, secretRevision, rootKeyVersion]`
    // is unique, so the SAME revision under a NEW root key is a legal second row
    // — which is exactly what `re-encrypt-credential.ts` writes, and the only
    // reason the unique key includes the root key version at all.
    const credentialId = "aa000000-0000-4000-8000-00000000e002";
    await seedCredential(credentialId, "reencrypted");

    const first = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertSecretVersion(
        {
          id: versionIdOf("bb000000-0000-4000-8000-00000000e002"),
          credentialId: credentialIdOf(credentialId),
          secretRevision: revisionOf(7),
          formatVersion: 1,
          rootKeyVersion: rootKeyOf(1),
          ...ENVELOPE_V1,
          createdAt: AT,
        },
        transaction,
      ),
    );
    expect(first.ok).toBe(true);

    const second = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertSecretVersion(
        {
          id: versionIdOf("bb000000-0000-4000-8000-00000000e003"),
          credentialId: credentialIdOf(credentialId),
          secretRevision: revisionOf(7),
          formatVersion: 1,
          rootKeyVersion: rootKeyOf(2),
          ...ENVELOPE_V2,
          createdAt: LATER,
        },
        transaction,
      ),
    );
    expect(second.ok).toBe(true);
    if (!second.ok || !first.ok) return;

    // The two rows carry DIFFERENT ciphertexts of the same secret, which is what
    // a re-encryption produces: a fresh salt, a fresh nonce and a fresh key.
    expect(hex(second.value.ciphertext)).not.toBe(hex(first.value.ciphertext));
    expect(hex(second.value.salt)).not.toBe(hex(first.value.salt));
    expect(hex(second.value.nonce)).not.toBe(hex(first.value.nonce));
  });

  it("refuses a second row at the same revision AND the same root key version", async () => {
    // The other side of the unique key, and the reason re-encryption is not just
    // an UPDATE. Two rows for one (revision, root key) pair is two answers to
    // "which envelope is this", and PostgreSQL is what refuses it.
    const credentialId = "aa000000-0000-4000-8000-00000000e004";
    await seedCredential(credentialId, "duplicate-version");

    const first = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertSecretVersion(
        {
          id: versionIdOf("bb000000-0000-4000-8000-00000000e004"),
          credentialId: credentialIdOf(credentialId),
          secretRevision: revisionOf(1),
          formatVersion: 1,
          rootKeyVersion: rootKeyOf(1),
          ...ENVELOPE_V1,
          createdAt: AT,
        },
        transaction,
      ),
    );
    expect(first.ok).toBe(true);

    const duplicate = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertSecretVersion(
        {
          // A DIFFERENT primary key, so the refusal comes from the composite
          // unique index and not from the identifier.
          id: versionIdOf("bb000000-0000-4000-8000-00000000e005"),
          credentialId: credentialIdOf(credentialId),
          secretRevision: revisionOf(1),
          formatVersion: 1,
          rootKeyVersion: rootKeyOf(1),
          ...ENVELOPE_V2,
          createdAt: LATER,
        },
        transaction,
      ),
    );
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(duplicate.error.code).toBe("SECRET_VERSION_ALREADY_EXISTS");
  });

  it("counts unpurged envelopes per root key version, which is how far a rotation got", async () => {
    // `countVersionsByRootKey` is what `rootKeyReport` and `canRemoveRootKey`
    // are computed from: a prior key may not leave the ring while anything
    // unpurged still names it. The rows seeded above put real counts behind
    // versions 1, 2 and 9.
    const counted = await harness.repository.countVersionsByRootKey();
    expect(counted.ok).toBe(true);
    if (!counted.ok) return;

    const byVersion = new Map(counted.value.map((row) => [row.rootKeyVersion as number, row.unpurgedVersionCount]));
    expect(byVersion.get(9)).toBeGreaterThanOrEqual(1);
    expect(byVersion.get(2)).toBeGreaterThanOrEqual(1);
    expect(byVersion.get(1)).toBeGreaterThanOrEqual(3);
  });
});
