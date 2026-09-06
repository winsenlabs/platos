// The database rules NO port method restates, and the one place the double and
// the database disagree about what a row IS.
//
// `secrets-constraints.integration.test.ts` next door holds each GUARD against
// the CHECK it restates. This file is the other half: rules that no guard can
// stand in for, because they are not about the shape of a value at all. Four
// refuse an UPDATE that changes a column the row is not allowed to change; one
// re-reads a DIFFERENT table from inside the write and refuses on what it finds
// there; one is a foreign key that would raise mid-batch if the port did not
// re-check every clause itself.
//
// NOT ONE OF THEM IS IN `schema.prisma`, so not one is in the generated client's
// types, and not one is in `inMemorySecretsStore`. Every use-case suite in the
// tree passes with a store that has none of them.
//
// Excluded from `vitest run` by the package's `test` script and run by
// `pnpm test:postgres-tenancy:integration` in its own CI job. It FAILS when
// Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { inMemorySecretsStore } from "@platos/context-secrets/application/index.js";
import type {
  EnvironmentId,
  TransactionScope,
} from "@platos/context-secrets/application/ports/index.js";

import type { SecretsHarness } from "./secrets-harness.js";
import {
  AT,
  CUTOFF,
  LATER,
  auditDraft,
  bytes,
  credentialDraft,
  credentialIdOf,
  revisionOf,
  rootKeyOf,
  startSecretsHarness,
  variableIdOf,
  versionDraft,
  versionIdOf,
} from "./secrets-harness.js";

let harness: SecretsHarness;
let environmentId: EnvironmentId;
let otherEnvironmentId: EnvironmentId;
let sequence = 0;

function fresh(): string {
  sequence += 1;
  return `5ec03333-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function inTransaction<Value>(
  work: (transaction: TransactionScope) => Promise<Value>,
): Promise<Value> {
  return harness.base.adapter.unitOfWork.run(work);
}

interface LiveCredential {
  readonly credentialId: string;
  readonly versionId: string;
}

/** A credential with an active envelope, written through the port. */
async function live(
  where: EnvironmentId,
  name: string,
  kind: "SECRET_REFERENCE" | "CHANNEL_SECRET" = "SECRET_REFERENCE",
  options: { readonly withoutActiveVersion?: boolean; readonly revoked?: boolean } = {},
): Promise<LiveCredential> {
  const credentialId = fresh();
  const versionId = fresh();
  await inTransaction(async (transaction) => {
    await harness.repository.insertCredential(
      credentialDraft({ id: credentialId, environmentId: where, kind, name }),
      transaction,
    );
    await harness.repository.insertSecretVersion(
      versionDraft({ id: versionId, credentialId, secretRevision: 1, rootKeyVersion: 1, fill: 0x61 }),
      transaction,
    );
    if (options.withoutActiveVersion !== true) {
      await harness.repository.setActiveSecretVersion(
        credentialIdOf(credentialId),
        versionIdOf(versionId),
        AT,
        transaction,
      );
    }
    if (options.revoked === true) {
      await harness.repository.revokeCredential(credentialIdOf(credentialId), LATER, transaction);
    }
  });
  return { credentialId, versionId };
}

beforeAll(async () => {
  harness = await startSecretsHarness();
  environmentId = await harness.freshEnvironment();
  otherEnvironmentId = await harness.freshEnvironment();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("four rules freeze a column the row may not change", () => {
  test("Credential_owner_immutable refuses a rename, and no port method issues one", async () => {
    const { credentialId } = await live(environmentId, "FROZEN_NAME");
    await expect(
      harness.base.client.credential.update({
        where: { id: credentialId },
        data: { name: "RENAMED" },
      }),
    ).rejects.toThrow();
    // The port's two UPDATEs write four columns between them and none of the
    // four frozen ones is among them, so the rule never fires on a legitimate
    // write. Proved by making both and reading the frozen columns back.
    await inTransaction((transaction) =>
      harness.repository.setActiveSecretVersion(credentialIdOf(credentialId), null, LATER, transaction),
    );
    await inTransaction((transaction) =>
      harness.repository.revokeCredential(credentialIdOf(credentialId), LATER, transaction),
    );
    const row = await harness.base.client.credential.findUnique({
      where: { id: credentialId },
      select: { name: true, kind: true, environmentId: true, provider: true, revokedAt: true },
    });
    expect(row).toEqual({
      name: "FROZEN_NAME",
      kind: "SECRET_REFERENCE",
      environmentId,
      provider: null,
      revokedAt: LATER,
    });
  });

  test("the envelope is immutable, and retirement writes exactly the two columns it may", async () => {
    const { credentialId, versionId } = await live(environmentId, "FROZEN_ENVELOPE");
    await expect(
      harness.base.client.credentialSecretVersion.update({
        where: { id: versionId },
        data: { ciphertext: bytes(8, 0x99) },
      }),
    ).rejects.toThrow();
    await expect(
      harness.base.client.credentialSecretVersion.update({
        where: { id: versionId },
        data: { rootKeyVersion: 7 },
      }),
    ).rejects.toThrow();
    const retired = await inTransaction((transaction) =>
      harness.repository.retireSecretVersion(versionIdOf(versionId), LATER, CUTOFF, transaction),
    );
    expect(retired).toMatchObject({ ok: true, value: { retiredAt: LATER, readableUntil: CUTOFF } });
    const row = await harness.base.client.credentialSecretVersion.findUnique({
      where: { id: versionId },
      select: { rootKeyVersion: true, secretRevision: true, credentialId: true, createdAt: true },
    });
    expect(row).toEqual({
      rootKeyVersion: 1,
      secretRevision: 1,
      credentialId,
      createdAt: AT,
    });
  });

  test("CredentialAudit refuses UPDATE and DELETE, and the port offers neither", async () => {
    const { credentialId } = await live(environmentId, "AUDITED");
    const auditId = fresh();
    await inTransaction((transaction) =>
      harness.repository.appendAudit(
        auditDraft({ id: auditId, environmentId, credentialId, action: "CREATE" }),
        transaction,
      ),
    );
    await expect(
      harness.base.client.credentialAudit.update({
        where: { id: auditId },
        data: { outcome: "FAILED" },
      }),
    ).rejects.toThrow();
    await expect(
      harness.base.client.credentialAudit.delete({ where: { id: auditId } }),
    ).rejects.toThrow();
    // The row is still exactly what was appended, which is the property "an
    // unauditable mutation does not happen" ultimately rests on.
    // `createdAt` is asserted too, and that is not decoration: the column
    // defaults to `CURRENT_TIMESTAMP`, so a store that dropped the draft's
    // instant would stamp the wall clock and every audit row would be
    // un-correlatable with the mutation it evidences.
    const row = await harness.base.client.credentialAudit.findUnique({
      where: { id: auditId },
      select: { outcome: true, action: true, createdAt: true },
    });
    expect(row).toEqual({ outcome: "SUCCESS", action: "CREATE", createdAt: AT });
  });

  // WIN-259 (M2.4). `DENIED` has been in `CREDENTIAL_AUDIT_OUTCOMES` since
  // `secrets` was written and nothing ever wrote one, so until this branch NO
  // ROW WITH THAT VALUE HAD EVER REACHED PostgreSQL. The in-memory double stores
  // whatever string it is handed, which is exactly the shape of the failure this
  // project has recorded before: the doubles mint values the database refuses,
  // and every use-case suite passes.
  //
  // Two things only a real database answers here. `outcome` is TEXT NOT NULL
  // with NO CHECK — read from the MIGRATION, since `schema.prisma` shows the
  // type and not the absence — so the value lands; and the row satisfies the
  // COMPOSITE foreign key `(credentialId, environmentId)`, which is the one a
  // denial path could plausibly break by resolving a credential in the wrong
  // environment.
  test("a DENIED outcome reaches PostgreSQL, and commits in a transaction of its OWN", async () => {
    const { credentialId } = await live(environmentId, "PROBED");
    const auditId = fresh();
    // A SEPARATE unit of work, which is the whole point: the read this row is
    // evidence of failed, so a row written inside that read's transaction would
    // roll back with it. Committing here and staying committed is the property.
    await inTransaction((transaction) =>
      harness.repository.appendAudit(
        auditDraft({
          id: auditId,
          environmentId,
          credentialId,
          action: "READ",
          outcome: "DENIED",
          secretRevision: 1,
          fromRootKeyVersion: 1,
          toRootKeyVersion: 1,
        }),
        transaction,
      ),
    );
    const row = await harness.base.client.credentialAudit.findUnique({
      where: { id: auditId },
      select: {
        outcome: true,
        action: true,
        credentialId: true,
        environmentId: true,
        secretRevision: true,
        fromRootKeyVersion: true,
      },
    });
    expect(row).toEqual({
      outcome: "DENIED",
      action: "READ",
      credentialId,
      environmentId,
      secretRevision: 1,
      fromRootKeyVersion: 1,
    });
    // And it is immutable on the same terms as every other audit row, so the
    // evidence of a probe cannot be edited into evidence of a success.
    await expect(
      harness.base.client.credentialAudit.update({
        where: { id: auditId },
        data: { outcome: "SUCCESS" },
      }),
    ).rejects.toThrow();
  });

  test("EnvironmentVariable_owner_immutable refuses a re-key", async () => {
    const variableId = fresh();
    await inTransaction((transaction) =>
      harness.variables.upsert(
        {
          id: variableIdOf(variableId),
          environmentId,
          key: "FROZEN",
          kind: "PLAIN",
          value: "one",
          credentialId: null,
          lastUpdatedBy: null,
          at: AT,
          expectedVersion: null,
        },
        transaction,
      ),
    );
    await expect(
      harness.base.client.environmentVariable.update({
        where: { id: variableId },
        data: { key: "RENAMED" },
      }),
    ).rejects.toThrow();
    await expect(
      harness.base.client.environmentVariable.update({
        where: { id: variableId },
        data: { environmentId: otherEnvironmentId },
      }),
    ).rejects.toThrow();
  });
});

describe("enforce_win124_credential_kind re-reads the credential from inside the write", () => {
  /** Every guard accepts these; only the database refuses them. */
  async function upsertSecret(key: string, credentialId: string): Promise<string> {
    try {
      await inTransaction((transaction) =>
        harness.variables.upsert(
          {
            id: variableIdOf(fresh()),
            environmentId,
            key,
            kind: "SECRET",
            value: null,
            credentialId: credentialIdOf(credentialId),
            lastUpdatedBy: null,
            at: AT,
            expectedVersion: null,
          },
          transaction,
        ),
      );
    } catch (error) {
      return error instanceof Error ? "<refused>" : "<uncoded>";
    }
    return "<accepted>";
  }

  test("the WRONG KIND is refused, and the in-memory double accepts it", async () => {
    const { credentialId } = await live(environmentId, "CHANNEL_ONE", "CHANNEL_SECRET");
    expect(await upsertSecret("WRONG_KIND", credentialId)).toBe("<refused>");
    // THE SAME CALL, against the double this context ships. It lands, which is
    // why no use-case suite in the tree could have found this.
    const fake = inMemorySecretsStore();
    const written = await fake.upsert(
      {
        id: variableIdOf(fresh()),
        environmentId,
        key: "WRONG_KIND",
        kind: "SECRET",
        value: null,
        credentialId: credentialIdOf(credentialId),
        lastUpdatedBy: null,
        at: AT,
        expectedVersion: null,
      },
      { transactionId: "fake" } as never,
    );
    expect(written).toMatchObject({ ok: true });
  });

  test("a REVOKED credential is refused", async () => {
    const { credentialId } = await live(environmentId, "REVOKED_REF", "SECRET_REFERENCE", {
      revoked: true,
    });
    expect(await upsertSecret("REVOKED_REF", credentialId)).toBe("<refused>");
  });

  test("a credential with NO ACTIVE VERSION is refused", async () => {
    const { credentialId } = await live(environmentId, "NO_VERSION", "SECRET_REFERENCE", {
      withoutActiveVersion: true,
    });
    expect(await upsertSecret("NO_VERSION", credentialId)).toBe("<refused>");
  });

  test("a credential in ANOTHER ENVIRONMENT is refused", async () => {
    const { credentialId } = await live(otherEnvironmentId, "FOREIGN_REF");
    expect(await upsertSecret("FOREIGN_REF", credentialId)).toBe("<refused>");
  });

  test("and the credential that satisfies every clause lands", async () => {
    const { credentialId } = await live(environmentId, "GOOD_REF");
    expect(await upsertSecret("GOOD_REF", credentialId)).toBe("<accepted>");
  });
});

describe("the active envelope cannot be destroyed, two different ways", () => {
  test("a raw delete RAISES and the port's purge answers zero", async () => {
    const { credentialId, versionId } = await live(environmentId, "ACTIVE_ENVELOPE");
    // `Credential_activeSecretVersionId_id_fkey` is ON DELETE RESTRICT, so this
    // raises SQLSTATE 23503 — mid-batch, with the transaction already poisoned.
    await expect(
      harness.base.client.credentialSecretVersion.delete({ where: { id: versionId } }),
    ).rejects.toThrow();
    // The port re-checks `activeSecretVersionId IS DISTINCT FROM version."id"`
    // INSIDE the delete, so the same fact arrives as a zero-row result the caller
    // can read and roll back on.
    const purged = await inTransaction((transaction) =>
      harness.repository.purgeSecretVersion(
        {
          secretVersionId: versionIdOf(versionId),
          credentialId: credentialIdOf(credentialId),
          environmentId,
          secretRevision: revisionOf(1),
          rootKeyVersion: rootKeyOf(1),
        },
        CUTOFF,
        transaction,
      ),
    );
    expect(purged).toEqual({ ok: true, value: 0 });
    // And the transaction it ran in is still usable, which is the whole point.
    const audited = await inTransaction((transaction) =>
      harness.repository.appendAudit(
        auditDraft({ id: fresh(), environmentId, credentialId, action: "PURGE" }),
        transaction,
      ),
    );
    expect(audited).toEqual({ ok: true, value: undefined });
  });
});
