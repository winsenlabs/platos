// WIN-259 M2.4. Does a REAL PostgreSQL accept what the legacy migration PRODUCES,
// and refuse what it MIGRATES AWAY FROM?
//
// THE FINDING THIS SUITE EXISTS TO SETTLE, AND IT IS NOT IN `schema.prisma`.
// `secrets/domain/legacy-envelope.ts` claims that a format-2 or format-3 envelope
// is not merely un-writable by policy but UNSTORABLE in `CredentialSecretVersion`
// — that three CHECK constraints only the initial migration carries refuse it:
//
//   CredentialSecretVersion_salt_length_check   octet_length(salt)  = 32
//   CredentialSecretVersion_nonce_length_check  octet_length(nonce) = 12
//   CredentialSecretVersion_root_key_check      rootKeyVersion > 0
//
// That claim is what makes the migration a TRANSCODING rather than a column
// update, so the whole shape of the deliverable rests on it. Asserted in the
// domain it is a list this tranche wrote checked against a descriptor this
// tranche wrote — two things one tranche controls. Here it is checked against
// what a real PostgreSQL RAISES, which is neither.
//
// AND THE POSITIVE HALF MATTERS AS MUCH AS THE NEGATIVE. This repository has
// already paid for the lesson that a context's own in-memory double mints values
// PostgreSQL refuses. The migration's output is proven end to end in
// `keyring-envelope/src/legacy-migration.test.ts` — against an in-memory store.
// So the bytes a REAL migration produced are frozen below and inserted here: if
// the transcoding emitted a salt of the wrong width, or a nonce carried over from
// a 16-byte legacy iv, the row would be refused and every in-memory proof would
// still be green.
//
// WHY THE BYTES ARE FIXTURES. The joint proof — real rows AND real AES-256-GCM in
// one process — has no legal home: `adapter-is-self-contained` forbids this
// directory from importing `@platos/adapter-keyring-envelope`, and
// `tenancy-prisma-only` forbids that adapter from importing the ORM. So the chain
// is proven in two halves that meet on the SAME frozen bytes, exactly as
// `secrets-key-version.integration.test.ts` does for format 1.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EnvironmentId } from "@platos/context-tenancy/application/ports/index.js";

import type { SecretsHarness } from "./secrets-harness.js";
import {
  AT,
  credentialDraft,
  credentialIdOf,
  revisionOf,
  rootKeyOf,
  startSecretsHarness,
  versionIdOf,
} from "./secrets-harness.js";

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

// ---------------------------------------------------------------------------
// What the migration PRODUCED, byte for byte.
//
// Both were emitted by running `migrateLegacyEnvelope` with the real
// `keyring-envelope` adapter over the corresponding entry in that package's
// `legacy-wire-vectors.ts`, under root key version 7 and root key
// `0011...eeff`. They are RE-DECLARED rather than imported, because this
// directory may not import that package — the duplication is the boundary rule,
// and it is what a reader checks by eye.
//
// NOTE THE WIDTHS, WHICH ARE THE WHOLE POINT: a 32-byte salt and a 12-byte nonce
// that NEITHER legacy source produced. Format 2 carries no salt and a 12-byte
// iv; format 3 carries no salt and a 16-byte iv. The migration did not carry
// either across — it sealed afresh.
// ---------------------------------------------------------------------------

/** Migrated from `legacy-wire-vectors.ts` "format 2, a TOTP secret …". */
const MIGRATED_FROM_FORMAT_2 = Object.freeze({
  salt: hexBytes("9f1d4e25e1a022a918df55d5f3ea73d5177e70ef7454618068c8c8ce802bfee5"),
  nonce: hexBytes("31217a0ca7a30a8366dd8d5b"),
  ciphertext: hexBytes("f4d497710bbec8a8846e59ff0744092f"),
  authTag: hexBytes("060edc03b23f34190c2d79b210207daa"),
});

/** Migrated from `legacy-wire-vectors.ts` "format 3, an API key …". */
const MIGRATED_FROM_FORMAT_3 = Object.freeze({
  salt: hexBytes("4b7aa340329ca5ab4741ee0315f7062fff9dc67aa2f3d6b3b76a3161f88a9129"),
  nonce: hexBytes("d06483336767757e59233c1d"),
  ciphertext: hexBytes("9e707e15f270c95bd26385ce6f813bdc23b6152e930db21efa41b5ae7bca825b5d7a"),
  authTag: hexBytes("481ffbe57f1bb422672bf4f2cdf94975"),
});

/** The root key version the migration sealed under. Inside the derived key. */
const MIGRATED_ROOT_KEY_VERSION = 7;

let harness: SecretsHarness;
let environmentId: EnvironmentId;

/**
 * The client, for the statements below that name a table literally.
 *
 * Spelled AT THE CALL SITE rather than taken as a parameter, for the reason
 * `agents-constraints.integration.test.ts` gives: `scripts/arch/sole-writer.mjs`
 * attributes a raw statement to the table its SQL names, and SQL arriving as an
 * argument cannot be attributed at all, so the gate fails closed on it.
 */
function db(): { $executeRawUnsafe(text: string, ...values: unknown[]): Promise<number> } {
  return harness.base.client as never as {
    $executeRawUnsafe(text: string, ...values: unknown[]): Promise<number>;
  };
}

beforeAll(async () => {
  harness = await startSecretsHarness();
  environmentId = await harness.freshEnvironment();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

async function seedCredential(id: string, name: string): Promise<void> {
  const written = await harness.base.adapter.unitOfWork.run((transaction) =>
    harness.repository.insertCredential(
      credentialDraft({ id, environmentId, kind: "ENTITY_SECRET", name, provider: "openai" }),
      transaction,
    ),
  );
  expect(written.ok).toBe(true);
}

describe("what the migration produced is storable, byte for byte", () => {
  it("stores and returns a row migrated from a format-2 column unchanged", async () => {
    const credentialId = "aa000000-0000-4000-8000-00000000f002";
    const versionId = "bb000000-0000-4000-8000-00000000f002";
    await seedCredential(credentialId, "migrated-from-format-2");

    const stored = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertSecretVersion(
        {
          id: versionIdOf(versionId),
          credentialId: credentialIdOf(credentialId),
          secretRevision: revisionOf(1),
          formatVersion: 1,
          rootKeyVersion: rootKeyOf(MIGRATED_ROOT_KEY_VERSION),
          ...MIGRATED_FROM_FORMAT_2,
          createdAt: AT,
        },
        transaction,
      ),
    );
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;

    await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.setActiveSecretVersion(
        credentialIdOf(credentialId),
        versionIdOf(versionId),
        AT,
        transaction,
      ),
    );

    const read = await harness.repository.findCredential({
      environmentId,
      credentialId: credentialIdOf(credentialId),
    });
    expect(read.ok).toBe(true);
    if (!read.ok || read.value === null || read.value.activeSecretVersion === null) {
      expect.unreachable("the migrated credential and its envelope must both come back");
      return;
    }
    const version = read.value.activeSecretVersion;

    // THE ASSERTION THAT MATTERS. These bytes open to "JBSWY3DPEHPK3PXP" in
    // `keyring-envelope/src/legacy-migration.test.ts`. One flipped bit here and
    // the TOTP secret that survived the migration is gone again, permanently.
    expect(hex(version.salt)).toBe("9f1d4e25e1a022a918df55d5f3ea73d5177e70ef7454618068c8c8ce802bfee5");
    expect(hex(version.nonce)).toBe("31217a0ca7a30a8366dd8d5b");
    expect(hex(version.ciphertext)).toBe("f4d497710bbec8a8846e59ff0744092f");
    expect(hex(version.authTag)).toBe("060edc03b23f34190c2d79b210207daa");
    expect(version.rootKeyVersion).toBe(MIGRATED_ROOT_KEY_VERSION);
    expect(version.formatVersion).toBe(1);
  });

  it("stores a 34-byte migrated ciphertext beside a 16-byte one without padding either", async () => {
    // Two real migrated ciphertexts of different lengths in the same column. A
    // `Bytes` column that padded, or a decoder that assumed a width, is caught by
    // the pair rather than by either row alone.
    const credentialId = "aa000000-0000-4000-8000-00000000f003";
    const versionId = "bb000000-0000-4000-8000-00000000f003";
    await seedCredential(credentialId, "migrated-from-format-3");

    const stored = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertSecretVersion(
        {
          id: versionIdOf(versionId),
          credentialId: credentialIdOf(credentialId),
          secretRevision: revisionOf(1),
          formatVersion: 1,
          rootKeyVersion: rootKeyOf(MIGRATED_ROOT_KEY_VERSION),
          ...MIGRATED_FROM_FORMAT_3,
          createdAt: AT,
        },
        transaction,
      ),
    );
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value.ciphertext).toHaveLength(34);
    expect(MIGRATED_FROM_FORMAT_2.ciphertext).toHaveLength(16);

    await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.setActiveSecretVersion(
        credentialIdOf(credentialId),
        versionIdOf(versionId),
        AT,
        transaction,
      ),
    );
    const read = await harness.repository.findCredential({
      environmentId,
      credentialId: credentialIdOf(credentialId),
    });
    if (!read.ok || read.value === null || read.value.activeSecretVersion === null) {
      expect.unreachable("the migrated credential and its envelope must both come back");
      return;
    }
    expect(hex(read.value.activeSecretVersion.ciphertext)).toBe(
      "9e707e15f270c95bd26385ce6f813bdc23b6152e930db21efa41b5ae7bca825b5d7a",
    );
  });

  it("emits the widths the three CHECKs demand, from BOTH legacy sources", async () => {
    // Read straight off the fixtures, before any database is involved. If the
    // migration ever stopped sealing afresh — carried a legacy nonce across, say
    // — this fails without needing a container to say so, and the two cases above
    // would fail for a reason a reader would have to dig for.
    for (const migrated of [MIGRATED_FROM_FORMAT_2, MIGRATED_FROM_FORMAT_3]) {
      expect(migrated.salt).toHaveLength(32);
      expect(migrated.nonce).toHaveLength(12);
      expect(migrated.authTag).toHaveLength(16);
    }
    // And the two are genuinely different envelopes of different plaintexts, so
    // neither case above can be passing on the other's bytes.
    expect(hex(MIGRATED_FROM_FORMAT_2.salt)).not.toBe(hex(MIGRATED_FROM_FORMAT_3.salt));
  });
});

describe("what the migration migrates AWAY FROM is unstorable", () => {
  it("refuses a format-2-shaped row: no salt at all", async () => {
    // FORMAT 2 IS `saltBytes: 0`. The row is otherwise perfectly well formed —
    // a 12-byte nonce the column accepts and a 16-byte tag — so the ONLY thing
    // refusing it is the salt width, and the constraint NAME in the raise is
    // what says so. This is why the migration cannot be an in-place update: the
    // row it would have updated could never have existed.
    await seedCredential("aa000000-0000-4000-8000-00000000f102", "legacy-format-2-shape");
    await expect(
      db().$executeRawUnsafe(
        `INSERT INTO "CredentialSecretVersion"
           ("id","credentialId","secretRevision","formatVersion","rootKeyVersion",
            "salt","nonce","ciphertext","authTag","createdAt")
         VALUES ($1::uuid,$2::uuid,1,2,1,
                 ''::bytea, decode($3,'hex'), decode($4,'hex'), decode($5,'hex'), NOW())`,
        "bb000000-0000-4000-8000-00000000f102",
        "aa000000-0000-4000-8000-00000000f102",
        "31217a0ca7a30a8366dd8d5b",
        "f4d497710bbec8a8846e59ff0744092f",
        "060edc03b23f34190c2d79b210207daa",
      ),
    ).rejects.toThrow(/CredentialSecretVersion_salt_length_check/u);
  });

  it("refuses a format-3-shaped row: no salt AND a 16-byte iv", async () => {
    // FORMAT 3 IS `saltBytes: 0` AND `nonceBytes: 16`. Given a 32-byte salt so
    // the salt CHECK cannot be what fires, the 16-byte iv is left alone to be
    // refused — which is the second of the three constraints, and the one that
    // makes the two legacy formats un-storable for DIFFERENT reasons.
    await seedCredential("aa000000-0000-4000-8000-00000000f103", "legacy-format-3-shape");
    await expect(
      db().$executeRawUnsafe(
        `INSERT INTO "CredentialSecretVersion"
           ("id","credentialId","secretRevision","formatVersion","rootKeyVersion",
            "salt","nonce","ciphertext","authTag","createdAt")
         VALUES ($1::uuid,$2::uuid,1,3,1,
                 decode($3,'hex'), decode($4,'hex'), decode($5,'hex'), decode($6,'hex'), NOW())`,
        "bb000000-0000-4000-8000-00000000f103",
        "aa000000-0000-4000-8000-00000000f103",
        "9f1d4e25e1a022a918df55d5f3ea73d5177e70ef7454618068c8c8ce802bfee5",
        "d06483336767757e59233c1d0000cafe",
        "9e707e15f270c95bd26385ce6f813bdc",
        "481ffbe57f1bb422672bf4f2cdf94975",
      ),
    ).rejects.toThrow(/CredentialSecretVersion_nonce_length_check/u);
  });

  it("refuses the root key version a legacy envelope does not have", async () => {
    // NEITHER LEGACY FORMAT CARRIES A ROOT KEY VERSION —
    // `versionedRootKey: false` for both — so an import that had to put SOMETHING
    // in the column would put the absence, and 0 is the only honest spelling of
    // it. The third constraint refuses that too, which is why a legacy envelope
    // is unstorable even when its widths are forced to fit.
    await seedCredential("aa000000-0000-4000-8000-00000000f104", "legacy-no-root-key");
    await expect(
      db().$executeRawUnsafe(
        `INSERT INTO "CredentialSecretVersion"
           ("id","credentialId","secretRevision","formatVersion","rootKeyVersion",
            "salt","nonce","ciphertext","authTag","createdAt")
         VALUES ($1::uuid,$2::uuid,1,2,0,
                 decode($3,'hex'), decode($4,'hex'), decode($5,'hex'), decode($6,'hex'), NOW())`,
        "bb000000-0000-4000-8000-00000000f104",
        "aa000000-0000-4000-8000-00000000f104",
        "9f1d4e25e1a022a918df55d5f3ea73d5177e70ef7454618068c8c8ce802bfee5",
        "31217a0ca7a30a8366dd8d5b",
        "f4d497710bbec8a8846e59ff0744092f",
        "060edc03b23f34190c2d79b210207daa",
      ),
    ).rejects.toThrow(/CredentialSecretVersion_root_key_check/u);
  });

  it("accepts the SAME statement once the shape is canonical", async () => {
    // THE CONTROL THAT KEEPS THE THREE REFUSALS ABOVE FROM BEING VACUOUS. Same
    // table, same raw statement shape, same column list — a 32-byte salt, a
    // 12-byte nonce and a positive root key version, which is exactly what the
    // migration emits. If the three above were failing for some unrelated reason
    // — a bad cast, a missing column, a foreign key — this would fail too.
    await seedCredential("aa000000-0000-4000-8000-00000000f105", "canonical-shape-control");
    const written = await db().$executeRawUnsafe(
      `INSERT INTO "CredentialSecretVersion"
         ("id","credentialId","secretRevision","formatVersion","rootKeyVersion",
          "salt","nonce","ciphertext","authTag","createdAt")
       VALUES ($1::uuid,$2::uuid,1,1,7,
               decode($3,'hex'), decode($4,'hex'), decode($5,'hex'), decode($6,'hex'), NOW())`,
      "bb000000-0000-4000-8000-00000000f105",
      "aa000000-0000-4000-8000-00000000f105",
      "9f1d4e25e1a022a918df55d5f3ea73d5177e70ef7454618068c8c8ce802bfee5",
      "31217a0ca7a30a8366dd8d5b",
      "f4d497710bbec8a8846e59ff0744092f",
      "060edc03b23f34190c2d79b210207daa",
    );
    expect(written).toBe(1);
  });
});
