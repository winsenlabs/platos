// Every guard in `secrets-guards.ts`, held against the constraint it restates.
//
// EACH CASE IS TWO HALVES. The first calls the port with a value the in-memory
// double accepts and watches the guard refuse it by NAME. The second sends the
// SAME value straight to the client, past the guard, and watches PostgreSQL
// refuse it too. A guard that drifted looser than its constraint fails the
// second half; one that drifted tighter fails the conformance run, which uses
// values both stores accept.
//
// IT IS THE VAULT'S THREE ROWS ONLY. `EnvironmentVariable`'s three CHECKs, and
// the two guards that have no constraint behind them at all, are in
// `secrets-variable-constraints.integration.test.ts` — ADR M0.3 §6's budget
// pointed at that seam and the seam is real: this file is about the shapes a
// CREDENTIAL and its envelope admit, and that one is about the configuration row
// that points at one.
//
// AND ONE GUARD IS DELIBERATELY LOOSER THAN ITS SIBLING. `requireAuditOrdinal`
// bounds the INTEGER and stops: `CredentialAudit` carries no `> 0` CHECK, unlike
// `CredentialSecretVersion`, so a guard demanding positivity there would be
// stricter than the database. The case that proves it writes a NEGATIVE revision
// to the audit through the port and watches it land.
//
// Excluded from `vitest run` by the package's `test` script and run by
// `pnpm test:postgres-tenancy:integration` in its own CI job. It FAILS when
// Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  EnvironmentId,
  TransactionScope,
} from "@platos/context-secrets/application/ports/index.js";
import { runResult } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import {
  AUDIT_ORDINAL_OUT_OF_RANGE,
  ENVELOPE_BYTES_MISWIDTH,
  ENVELOPE_ORDINAL_OUT_OF_RANGE,
  IDENTIFIER_NOT_UUID,
} from "./secrets-guards.js";
import type { SecretsHarness } from "./secrets-harness.js";
import {
  AT,
  auditDraft,
  bytes,
  credentialDraft,
  credentialIdOf,
  envelope,
  startSecretsHarness,
  versionDraft,
  versionIdOf,
} from "./secrets-harness.js";

let harness: SecretsHarness;
let environmentId: EnvironmentId;
/** The live credential every envelope case in this file hangs off. */
let liveCredentialId: string;
let sequence = 0;

function uuid(slot: string): string {
  return `5ec01111-${slot}-4000-8000-000000000000`;
}

/** A fresh uuid, so no two cases in this suite can collide on a key. */
function fresh(): string {
  sequence += 1;
  return `5ec02222-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

beforeAll(async () => {
  harness = await startSecretsHarness();
  environmentId = await harness.freshEnvironment();
  liveCredentialId = uuid("0001");
  const versionId = uuid("0002");
  await harness.base.adapter.unitOfWork.run(async (transaction) => {
    await harness.repository.insertCredential(
      credentialDraft({
        id: liveCredentialId,
        environmentId,
        kind: "SECRET_REFERENCE",
        name: "LIVE_KEY",
      }),
      transaction,
    );
    await harness.repository.insertSecretVersion(
      versionDraft({
        id: versionId,
        credentialId: liveCredentialId,
        secretRevision: 1,
        rootKeyVersion: 1,
        fill: 0x11,
      }),
      transaction,
    );
    await harness.repository.setActiveSecretVersion(
      credentialIdOf(liveCredentialId),
      versionIdOf(versionId),
      AT,
      transaction,
    );
  });
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

/** The refusal code an error carries, or a marker naming what arrived instead. */
function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return `<uncoded:${String(error)}>`;
}

async function refusalOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return codeOf(error);
  }
  return "<no refusal>";
}

function inTransaction<Value>(
  work: (transaction: TransactionScope) => Promise<Result<Value>>,
): Promise<Result<Value>> {
  return runResult(harness.base.adapter.unitOfWork, work);
}

/** An envelope row written straight to the client, past every guard. */
function rawVersion(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: fresh(),
    credentialId: liveCredentialId,
    secretRevision: 9,
    formatVersion: 1,
    rootKeyVersion: 9,
    ...envelope(0x55),
    createdAt: AT,
    ...overrides,
  };
}

describe("identifiers, ordinals and envelope widths", () => {
  test("a readable placeholder is refused by the guard and by the uuid column", async () => {
    expect(
      await refusalOf(() =>
        inTransaction((transaction) =>
          harness.repository.insertCredential(
            credentialDraft({
              id: "credential-1",
              environmentId,
              kind: "ENTITY_SECRET",
              name: "PLACEHOLDER",
            }),
            transaction,
          ),
        ),
      ),
    ).toBe(IDENTIFIER_NOT_UUID);
    await expect(
      harness.base.client.credential.create({
        data: {
          id: "credential-1",
          environmentId,
          kind: "ENTITY_SECRET",
          name: "PLACEHOLDER",
          createdAt: AT,
          updatedAt: AT,
        } as never,
      }),
    ).rejects.toThrow();
  });

  test("a zero revision is refused by the guard and by the revision CHECK", async () => {
    expect(
      await refusalOf(() =>
        inTransaction((transaction) =>
          harness.repository.insertSecretVersion(
            versionDraft({
              id: fresh(),
              credentialId: liveCredentialId,
              secretRevision: 0,
              rootKeyVersion: 1,
              fill: 0x21,
            }),
            transaction,
          ),
        ),
      ),
    ).toBe(ENVELOPE_ORDINAL_OUT_OF_RANGE);
    await expect(
      harness.base.client.credentialSecretVersion.create({
        data: rawVersion({ secretRevision: 0 }) as never,
      }),
    ).rejects.toThrow();
  });

  test("a zero root key version is refused by the guard and by its own CHECK", async () => {
    expect(
      await refusalOf(() =>
        inTransaction((transaction) =>
          harness.repository.insertSecretVersion(
            versionDraft({
              id: fresh(),
              credentialId: liveCredentialId,
              secretRevision: 5,
              rootKeyVersion: 0,
              fill: 0x22,
            }),
            transaction,
          ),
        ),
      ),
    ).toBe(ENVELOPE_ORDINAL_OUT_OF_RANGE);
    await expect(
      harness.base.client.credentialSecretVersion.create({
        data: rawVersion({ rootKeyVersion: 0 }) as never,
      }),
    ).rejects.toThrow();
  });

  test("a 31-byte salt is refused by the guard and by the octet_length CHECK", async () => {
    // THE FAKE CIPHER MINTS 32 BYTES, so this width has never been exercised by
    // any use-case suite in the tree. A real cipher that changed it would be
    // caught by the database and by nothing else.
    const draft = versionDraft({
      id: fresh(),
      credentialId: liveCredentialId,
      secretRevision: 6,
      rootKeyVersion: 1,
      fill: 0x23,
    });
    expect(
      await refusalOf(() =>
        inTransaction((transaction) =>
          harness.repository.insertSecretVersion(
            { ...draft, salt: bytes(31, 0x23) },
            transaction,
          ),
        ),
      ),
    ).toBe(ENVELOPE_BYTES_MISWIDTH);
    await expect(
      harness.base.client.credentialSecretVersion.create({
        data: rawVersion({ salt: bytes(31, 0x23) }) as never,
      }),
    ).rejects.toThrow();
  });

  test("a 13-byte nonce and a 15-byte tag are refused the same two ways", async () => {
    const draft = versionDraft({
      id: fresh(),
      credentialId: liveCredentialId,
      secretRevision: 7,
      rootKeyVersion: 1,
      fill: 0x24,
    });
    expect(
      await refusalOf(() =>
        inTransaction((transaction) =>
          harness.repository.insertSecretVersion(
            { ...draft, nonce: bytes(13, 0x24) },
            transaction,
          ),
        ),
      ),
    ).toBe(ENVELOPE_BYTES_MISWIDTH);
    expect(
      await refusalOf(() =>
        inTransaction((transaction) =>
          harness.repository.insertSecretVersion(
            { ...draft, authTag: bytes(15, 0x24) },
            transaction,
          ),
        ),
      ),
    ).toBe(ENVELOPE_BYTES_MISWIDTH);
    await expect(
      harness.base.client.credentialSecretVersion.create({
        data: rawVersion({ nonce: bytes(13, 0x24) }) as never,
      }),
    ).rejects.toThrow();
    await expect(
      harness.base.client.credentialSecretVersion.create({
        data: rawVersion({ authTag: bytes(15, 0x24) }) as never,
      }),
    ).rejects.toThrow();
  });

  test("the ciphertext has NO width rule, here or in the migration", async () => {
    // The asymmetry is the finding, and it is the right way round: a plaintext
    // is as long as it is, and a guard inventing a bound would refuse a row the
    // column accepts.
    const draft = versionDraft({
      id: fresh(),
      credentialId: liveCredentialId,
      secretRevision: 8,
      rootKeyVersion: 1,
      fill: 0x25,
    });
    const written = await inTransaction((transaction) =>
      harness.repository.insertSecretVersion(
        { ...draft, ciphertext: bytes(4096, 0x25) },
        transaction,
      ),
    );
    expect(written).toMatchObject({ ok: true });
  });
});

describe("the audit row is looser than the envelope, and the guard says so", () => {
  test("an ordinal past INTEGER is refused by the guard and by the column", async () => {
    expect(
      await refusalOf(() =>
        inTransaction((transaction) =>
          harness.repository.appendAudit(
            auditDraft({
              id: fresh(),
              environmentId,
              credentialId: liveCredentialId,
              action: "READ",
              secretRevision: 2_147_483_648,
            }),
            transaction,
          ),
        ),
      ),
    ).toBe(AUDIT_ORDINAL_OUT_OF_RANGE);
    await expect(
      harness.base.client.credentialAudit.create({
        data: {
          id: fresh(),
          environmentId,
          credentialId: liveCredentialId,
          action: "READ",
          outcome: "SUCCESS",
          actorType: "operator",
          actorId: "operator-1",
          secretRevision: 2_147_483_648,
          createdAt: AT,
        } as never,
      }),
    ).rejects.toThrow();
  });

  test("a NEGATIVE audit revision lands, because no CHECK forbids it", async () => {
    // `CredentialSecretVersion_revision_check` exists; there is no
    // `CredentialAudit_revision_check`. A guard that demanded positivity here
    // would be stricter than the database — the drift that would only ever show
    // up as a refusal nobody could explain.
    const id = fresh();
    const written = await inTransaction((transaction) =>
      harness.repository.appendAudit(
        auditDraft({
          id,
          environmentId,
          credentialId: liveCredentialId,
          action: "READ",
          secretRevision: -1,
        }),
        transaction,
      ),
    );
    expect(written).toEqual({ ok: true, value: undefined });
    const row = await harness.base.client.credentialAudit.findUnique({
      where: { id },
      select: { secretRevision: true },
    });
    expect(row).toEqual({ secretRevision: -1 });
  });
});
