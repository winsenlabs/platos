// The migration's CONTROL FLOW, exercised with nothing running.
//
// WHAT THIS SUITE CAN AND CANNOT PROVE, STATED UP FRONT. The cipher here is
// `in-memory-crypto.ts`'s double, whose own header says "It is NOT cryptography."
// Its `openLegacy` fakes the PRIMITIVE while routing the payload through the same
// `requireMigratableFormat` and `requireLegacyEnvelopeShape` the real adapter
// uses. So this file proves the grant, the convergence branch, the revision, the
// audit row, the transaction and the read-back — and proves NOTHING about whether
// real format-2 and format-3 bytes open.
//
// That claim is made where it can be falsified:
// `keyring-envelope/src/legacy-wire-compatibility.test.ts` opens six ciphertexts
// produced by the two extraction sources, and
// `legacy-migration.test.ts` in the same package carries one of each through this
// very use case end to end.

import { unwrap } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { envelopeFormat } from "../domain/envelope.js";
import { asSecretsIdentifier } from "../domain/ids.js";
import type { CredentialId, RootKeyVersion, SecretRevision, SecretVersionId } from "../domain/ids.js";
import { canonicalRowRefusals } from "../domain/legacy-envelope.js";
import { createCredential } from "./create-credential.js";
import { inMemorySecrets } from "./in-memory-dependencies.js";
import type { InMemorySecrets } from "./in-memory-dependencies.js";
import { inMemoryGrants } from "./in-memory-grants.js";
import type { InMemoryGrants } from "./in-memory-grants.js";
import { legacyPayload } from "./in-memory-crypto.js";
import { migrateLegacyEnvelope } from "./migrate-legacy-envelope.js";
import { readSecret } from "./read-secret.js";

let context: InMemorySecrets;
let grants: InMemoryGrants;
let unmigrated: CredentialId;

const LEGACY_PLAINTEXT = "JBSWY3DPEHPK3PXP";

/**
 * A credential whose material still lives in a legacy column.
 *
 * IT IS INSERTED THROUGH THE REPOSITORY RATHER THAN THROUGH `createCredential`,
 * because `createCredential` seals an envelope and this credential has none: an
 * import that created the row could not have sealed one, since the material was
 * still in a shape `CredentialSecretVersion`'s CHECK constraints refuse. A
 * credential with `activeSecretVersionId` null IS the state a migration finds.
 */
async function insertUnmigratedCredential(name: string): Promise<CredentialId> {
  const id = asSecretsIdentifier<CredentialId>(`credential-${name}`);
  await context.dependencies.unitOfWork.run(async (transaction) =>
    unwrap(
      await context.dependencies.repository.insertCredential(
        {
          id,
          environmentId: grants.operator.environmentId,
          kind: "ENTITY_SECRET",
          name,
          provider: "openai",
          createdBy: null,
          createdAt: context.clock.now(),
        },
        transaction,
      ),
    ),
  );
  return id;
}

beforeEach(async () => {
  context = inMemorySecrets();
  grants = inMemoryGrants();
  unmigrated = await insertUnmigratedCredential("LEGACY_TOTP");
});

describe("a legacy column becomes a canonical envelope", () => {
  it("seals the legacy material at revision 1 under the ACTIVE root key", async () => {
    context.keyRing.rotateTo(4);
    const migrated = unwrap(
      await migrateLegacyEnvelope(context.dependencies, {
        authorization: grants.operator,
        credentialId: unmigrated,
        legacy: { formatVersion: 2, payload: legacyPayload(2, LEGACY_PLAINTEXT) },
      }),
    );
    // The ACTIVE version, not the lowest and not the one the legacy row named —
    // legacy formats name none. Rotating the ring first is what makes the
    // difference visible: a migration that sealed under version 1 would pass an
    // assertion that only checked "some version".
    expect(migrated.activeSecretVersion).toMatchObject({ secretRevision: 1, rootKeyVersion: 4 });
  });

  it("seals the canonical format, never the format it read", async () => {
    const migrated = unwrap(
      await migrateLegacyEnvelope(context.dependencies, {
        authorization: grants.operator,
        credentialId: unmigrated,
        legacy: { formatVersion: 3, payload: legacyPayload(3, LEGACY_PLAINTEXT) },
      }),
    );
    expect(migrated.activeSecretVersion?.formatVersion).toBe(1);
  });

  it("makes the material readable through the ordinary runtime read path", async () => {
    // THE POINT OF THE WHOLE ISSUE. Before this call the material was unreachable:
    // `openSecret` refuses any format whose descriptor is not `versionedRootKey`,
    // and there was no canonical row to open either. After it, the ordinary
    // runtime read returns the plaintext with no legacy code on the path.
    await migrateLegacyEnvelope(context.dependencies, {
      authorization: grants.operator,
      credentialId: unmigrated,
      legacy: { formatVersion: 2, payload: legacyPayload(2, LEGACY_PLAINTEXT) },
    });
    const material = unwrap(
      await readSecret(context.dependencies, {
        authorization: grants.runtime,
        credentialId: unmigrated,
      }),
    );
    expect(material.reveal()).toBe(LEGACY_PLAINTEXT);
  });

  it("records a MIGRATE audit with a `to` root key and NO `from`", async () => {
    // The asymmetry is the evidence: the material entered the ring rather than
    // moving within it. An audit row that named the same version in both columns
    // would assert a rewrap that never happened.
    await migrateLegacyEnvelope(context.dependencies, {
      authorization: grants.operator,
      credentialId: unmigrated,
      legacy: { formatVersion: 2, payload: legacyPayload(2, LEGACY_PLAINTEXT) },
    });
    const audit = context.store.allAudits().find((row) => row.action === "MIGRATE");
    expect(audit).toMatchObject({ secretRevision: 1, fromRootKeyVersion: null, toRootKeyVersion: 1 });
  });

  it("does not record a CREATE, because nothing was created here", async () => {
    // `MIGRATE` exists precisely so this row is distinguishable after the legacy
    // column is dropped. A migration that logged `CREATE` would erase the
    // provenance of every credential whose secret came from a raw-key envelope.
    await migrateLegacyEnvelope(context.dependencies, {
      authorization: grants.operator,
      credentialId: unmigrated,
      legacy: { formatVersion: 2, payload: legacyPayload(2, LEGACY_PLAINTEXT) },
    });
    expect(context.store.allAudits().some((row) => row.action === "CREATE")).toBe(false);
  });
});

describe("the refusal the migration exists to make unreachable", () => {
  it("REFUSES to open a legacy-format row, which is what made the material unreachable", async () => {
    // THE STATE THIS ISSUE WAS ABOUT, reproduced so the refusal is falsifiable.
    // `openSecret` rejects any format whose descriptor is not `versionedRootKey`,
    // which is both legacy formats — so a credential pointing at one is
    // permanently unreadable through every path this context publishes.
    //
    // NOTHING ELSE IN THIS PACKAGE ASSERTED THIS. The guard has been in
    // `envelope-operations.ts` since the context was written and no case named
    // it, so "the refusal" was a sentence rather than a measurement.
    const versionId = asSecretsIdentifier<SecretVersionId>("version-legacy-row");
    await context.dependencies.unitOfWork.run(async (transaction) => {
      unwrap(
        await context.dependencies.repository.insertSecretVersion(
          {
            id: versionId,
            credentialId: unmigrated,
            secretRevision: 1 as SecretRevision,
            formatVersion: 2,
            rootKeyVersion: 1 as RootKeyVersion,
            salt: new Uint8Array(0),
            nonce: new Uint8Array(12),
            ciphertext: new Uint8Array(8),
            authTag: new Uint8Array(16),
            createdAt: context.clock.now(),
          },
          transaction,
        ),
      );
      unwrap(
        await context.dependencies.repository.setActiveSecretVersion(
          unmigrated,
          versionId,
          context.clock.now(),
          transaction,
        ),
      );
    });

    const read = await readSecret(context.dependencies, {
      authorization: grants.runtime,
      credentialId: unmigrated,
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.details?.reason).toBe("envelope_format_unreadable");
  });

  it("is a state a real database cannot hold, which is why the fix is a transcoding", () => {
    // THE ROW ABOVE EXISTS ONLY BECAUSE THIS STORE IS A MAP. Its salt is zero
    // bytes, and `CredentialSecretVersion_salt_length_check` demands exactly 32,
    // so PostgreSQL refuses that INSERT outright —
    // `postgres-tenancy/src/secrets-legacy-envelope.integration.test.ts` asks a
    // real database and reads the constraint name back.
    //
    // That is the whole reason the migration reads a legacy STRING out of a
    // foreign column rather than updating a row in place: the row it would have
    // updated could never have been written. This case states the divergence
    // rather than hiding it, the way `agents-constraints` states the doubles'.
    expect(canonicalRowRefusals(envelopeFormat(2))).toContain(
      "CredentialSecretVersion_salt_length_check",
    );
    expect(canonicalRowRefusals(envelopeFormat(1))).toHaveLength(0);
  });
});

describe("it converges rather than clobbering", () => {
  it("returns a credential that is ALREADY canonical untouched", async () => {
    const canonical = unwrap(
      await createCredential(context.dependencies, {
        authorization: grants.operator,
        name: "ALREADY_CANONICAL",
        plaintext: "sk-live-rotated-properly",
      }),
    ).id;
    const result = unwrap(
      await migrateLegacyEnvelope(context.dependencies, {
        authorization: grants.operator,
        credentialId: canonical,
        legacy: { formatVersion: 2, payload: legacyPayload(2, "stale-legacy-column-value") },
      }),
    );
    expect(result.activeSecretVersion).toMatchObject({ secretRevision: 1 });
    // ONE version, not two: the stale legacy column did NOT overwrite the good
    // secret. That is the dangerous direction, and it is the one not expressible.
    expect(context.store.allVersions()).toHaveLength(1);
  });

  it("leaves the good secret readable after a stale legacy sweep touches it", async () => {
    const canonical = unwrap(
      await createCredential(context.dependencies, {
        authorization: grants.operator,
        name: "ALREADY_CANONICAL",
        plaintext: "sk-live-rotated-properly",
      }),
    ).id;
    await migrateLegacyEnvelope(context.dependencies, {
      authorization: grants.operator,
      credentialId: canonical,
      legacy: { formatVersion: 2, payload: legacyPayload(2, "stale-legacy-column-value") },
    });
    const material = unwrap(
      await readSecret(context.dependencies, {
        authorization: grants.runtime,
        credentialId: canonical,
      }),
    );
    expect(material.reveal()).toBe("sk-live-rotated-properly");
  });

  it("is safe to run twice — a half-finished sweep can be repeated", async () => {
    const command = {
      authorization: grants.operator,
      credentialId: unmigrated,
      legacy: { formatVersion: 2 as const, payload: legacyPayload(2, LEGACY_PLAINTEXT) },
    };
    unwrap(await migrateLegacyEnvelope(context.dependencies, command));
    unwrap(await migrateLegacyEnvelope(context.dependencies, command));
    expect(context.store.allVersions()).toHaveLength(1);
    expect(context.store.allAudits().filter((row) => row.action === "MIGRATE")).toHaveLength(1);
  });
});

describe("it fails closed", () => {
  it("DENIES a read-only operator grant", async () => {
    const denied = await migrateLegacyEnvelope(context.dependencies, {
      authorization: grants.readOnlyOperator,
      credentialId: unmigrated,
      legacy: { formatVersion: 2, payload: legacyPayload(2, LEGACY_PLAINTEXT) },
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe("CREDENTIAL_FORBIDDEN");
  });

  it("DENIES the runtime tier, which may read secrets but never introduce them", async () => {
    // The gate that must not be `requireSecretRead`. The runtime tier is exactly
    // the tier that can read; letting it migrate would let it WRITE material into
    // the vault from a string it supplied.
    const denied = await migrateLegacyEnvelope(context.dependencies, {
      authorization: grants.runtime,
      credentialId: unmigrated,
      legacy: { formatVersion: 2, payload: legacyPayload(2, LEGACY_PLAINTEXT) },
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe("CREDENTIAL_FORBIDDEN");
  });

  it("refuses the canonical format WITHOUT taking a row lock", async () => {
    // The format is judged before the credential is loaded. A caller pointing
    // this at format 1 has made a mistake about its own data and should learn it
    // without a lock being taken on its behalf — the unit of work never opens.
    const before = context.unitOfWork.commits() + context.unitOfWork.rollbacks();
    const refused = await migrateLegacyEnvelope(context.dependencies, {
      authorization: grants.operator,
      credentialId: unmigrated,
      legacy: { formatVersion: 1, payload: "irrelevant" },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("LEGACY_ENVELOPE_UNREADABLE");
    expect(refused.error.details?.reason).toBe("format_is_already_canonical");
    expect(context.unitOfWork.commits() + context.unitOfWork.rollbacks()).toBe(before);
  });

  it("refuses a revoked credential", async () => {
    await context.dependencies.unitOfWork.run(async (transaction) =>
      unwrap(
        await context.dependencies.repository.revokeCredential(
          unmigrated,
          context.clock.now(),
          transaction,
        ),
      ),
    );
    const refused = await migrateLegacyEnvelope(context.dependencies, {
      authorization: grants.operator,
      credentialId: unmigrated,
      legacy: { formatVersion: 2, payload: legacyPayload(2, LEGACY_PLAINTEXT) },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.details?.reason).toBe("credential_revoked");
  });

  it("refuses a credential that does not exist", async () => {
    const refused = await migrateLegacyEnvelope(context.dependencies, {
      authorization: grants.operator,
      credentialId: asSecretsIdentifier<CredentialId>("credential-absent"),
      legacy: { formatVersion: 2, payload: legacyPayload(2, LEGACY_PLAINTEXT) },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.details?.reason).toBe("credential_not_found");
  });

  it("writes NOTHING when the legacy payload cannot be opened", async () => {
    // The whole operation is one transaction, so a payload that fails the tag
    // check must leave no version, no repointing and no audit row behind.
    const refused = await migrateLegacyEnvelope(context.dependencies, {
      authorization: grants.operator,
      credentialId: unmigrated,
      legacy: { formatVersion: 2, payload: "in-memory-legacy|2|some-plaintext|deadbeef" },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.details?.reason).toBe("legacy_envelope_open_failed");
    expect(context.store.allVersions()).toHaveLength(0);
    expect(context.store.allAudits()).toHaveLength(0);
  });

  it("leaves the credential unmigrated and still readable as nothing after a refusal", async () => {
    await migrateLegacyEnvelope(context.dependencies, {
      authorization: grants.operator,
      credentialId: unmigrated,
      legacy: { formatVersion: 2, payload: "in-memory-legacy|2|some-plaintext|deadbeef" },
    });
    const read = await readSecret(context.dependencies, {
      authorization: grants.runtime,
      credentialId: unmigrated,
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.details?.reason).toBe("no_active_secret_version");
  });
});
