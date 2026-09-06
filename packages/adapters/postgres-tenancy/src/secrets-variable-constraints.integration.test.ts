// The `EnvironmentVariable` guards, and the two guards that stand where NO
// constraint does.
//
// IT IS A SECOND CONSTRAINTS FILE BECAUSE ADR M0.3 §6's budget pointed at a real
// seam, exactly as it did for `tools-isolation.integration.test.ts` one tranche
// over. `secrets-constraints.integration.test.ts` next door is about the shapes
// the VAULT's three rows admit — identifiers, ordinals and the three exact
// envelope widths. This file is about the CONFIGURATION row that points at one,
// and about the two guards that have no CHECK behind them at all.
//
// EACH CASE IS STILL TWO HALVES. The first calls the port with a value the
// in-memory double accepts and watches the guard refuse it by NAME; the second
// sends the SAME value straight to the client, past the guard, and watches
// PostgreSQL refuse it too. A guard that drifted looser than its constraint
// fails the second half; one that drifted tighter fails the conformance run,
// which uses values both stores accept.
//
// Excluded from `vitest run` by the package's `test` script and run by
// `pnpm test:postgres-tenancy:integration` in its own CI job. It FAILS when
// Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  EnvironmentId,
  TransactionScope,
} from "@platos/context-secrets/application/ports/index.js";

import {
  INSTANT_NOT_REPRESENTABLE,
  PURGE_LIMIT_INVALID,
  VARIABLE_KEY_INVALID,
  VARIABLE_SHAPE_INCOHERENT,
  VARIABLE_VALUE_TOO_LONG,
} from "./secrets-guards.js";
import type { SecretsHarness } from "./secrets-harness.js";
import {
  AT,
  CUTOFF,
  credentialDraft,
  credentialIdOf,
  startSecretsHarness,
  variableIdOf,
  versionDraft,
  versionIdOf,
} from "./secrets-harness.js";

let harness: SecretsHarness;
let environmentId: EnvironmentId;
/** The live `SECRET_REFERENCE` every SECRET variable here points at. */
let liveCredentialId: string;
let sequence = 0;

/** A fresh uuid, so no two cases in this suite can collide on a key. */
function fresh(): string {
  sequence += 1;
  return `5ec07777-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

beforeAll(async () => {
  harness = await startSecretsHarness();
  environmentId = await harness.freshEnvironment();
  liveCredentialId = fresh();
  const versionId = fresh();
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
        fill: 0x31,
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
  work: (transaction: TransactionScope) => Promise<Value>,
): Promise<Value> {
  return harness.base.adapter.unitOfWork.run(work);
}

/** A variable row written straight to the client, past every guard. */
function rawVariable(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: fresh(),
    environmentId,
    key: "RAW_KEY",
    kind: "PLAIN",
    value: "raw",
    credentialId: null,
    version: 1,
    lastUpdatedBy: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

describe("the environment variable's three CHECKs", () => {
  test("a lowercase key is refused by the guard and by the key CHECK", async () => {
    expect(
      await refusalOf(() =>
        inTransaction((transaction) =>
          harness.variables.upsert(
            {
              id: variableIdOf(fresh()),
              environmentId,
              key: "lowercase",
              kind: "PLAIN",
              value: "x",
              credentialId: null,
              lastUpdatedBy: null,
              at: AT,
              expectedVersion: null,
            },
            transaction,
          ),
        ),
      ),
    ).toBe(VARIABLE_KEY_INVALID);
    await expect(
      harness.base.client.environmentVariable.create({
        data: rawVariable({ key: "lowercase" }) as never,
      }),
    ).rejects.toThrow();
  });

  test("a SECRET carrying a value is refused by the guard and by the shape CHECK", async () => {
    // THE SHAPE THAT WOULD PUT PLAINTEXT IN A COLUMN A TABLE DUMP READS. The
    // double stores it without complaint, and the port's type admits it: `value`
    // is `string | null` and `kind` is a separate field.
    expect(
      await refusalOf(() =>
        inTransaction((transaction) =>
          harness.variables.upsert(
            {
              id: variableIdOf(fresh()),
              environmentId,
              key: "LEAKY",
              kind: "SECRET",
              value: "plaintext",
              credentialId: credentialIdOf(liveCredentialId),
              lastUpdatedBy: null,
              at: AT,
              expectedVersion: null,
            },
            transaction,
          ),
        ),
      ),
    ).toBe(VARIABLE_SHAPE_INCOHERENT);
    await expect(
      harness.base.client.environmentVariable.create({
        data: rawVariable({
          key: "LEAKY",
          kind: "SECRET",
          value: "plaintext",
          credentialId: liveCredentialId,
        }) as never,
      }),
    ).rejects.toThrow();
  });

  test("a PLAIN with no value is refused by the guard and by the same CHECK", async () => {
    expect(
      await refusalOf(() =>
        inTransaction((transaction) =>
          harness.variables.upsert(
            {
              id: variableIdOf(fresh()),
              environmentId,
              key: "EMPTY",
              kind: "PLAIN",
              value: null,
              credentialId: null,
              lastUpdatedBy: null,
              at: AT,
              expectedVersion: null,
            },
            transaction,
          ),
        ),
      ),
    ).toBe(VARIABLE_SHAPE_INCOHERENT);
    await expect(
      harness.base.client.environmentVariable.create({
        data: rawVariable({ key: "EMPTY", value: null }) as never,
      }),
    ).rejects.toThrow();
  });

  test("a value past 8192 characters is refused by the guard and by the length CHECK", async () => {
    const long = "x".repeat(8193);
    expect(
      await refusalOf(() =>
        inTransaction((transaction) =>
          harness.variables.upsert(
            {
              id: variableIdOf(fresh()),
              environmentId,
              key: "LONG",
              kind: "PLAIN",
              value: long,
              credentialId: null,
              lastUpdatedBy: null,
              at: AT,
              expectedVersion: null,
            },
            transaction,
          ),
        ),
      ),
    ).toBe(VARIABLE_VALUE_TOO_LONG);
    await expect(
      harness.base.client.environmentVariable.create({
        data: rawVariable({ key: "LONG", value: long }) as never,
      }),
    ).rejects.toThrow();
  });

  test("the boundary value the column DOES accept lands through the port", async () => {
    // The other side of the line, and the reason the guard cannot simply be
    // "refuse anything long": a value of exactly 8192 characters satisfies
    // `EnvironmentVariable_value_length_check` and must satisfy the guard too.
    const written = await inTransaction((transaction) =>
      harness.variables.upsert(
        {
          id: variableIdOf(fresh()),
          environmentId,
          key: "AT_THE_LIMIT",
          kind: "PLAIN",
          value: "x".repeat(8192),
          credentialId: null,
          lastUpdatedBy: null,
          at: AT,
          expectedVersion: null,
        },
        transaction,
      ),
    );
    expect(written).toMatchObject({ ok: true, value: { key: "AT_THE_LIMIT", version: 1 } });
  });
});

describe("the two guards that stand where no CHECK does", () => {
  test("a zero purge bound is refused before it reaches a raw LIMIT", async () => {
    expect(
      await refusalOf(() =>
        inTransaction((transaction) =>
          harness.repository.listPurgeCandidates(CUTOFF, 0, transaction),
        ),
      ),
    ).toBe(PURGE_LIMIT_INVALID);
    // There is no constraint to hold this against: `LIMIT` is a clause, not a
    // column. What the database does with an unbounded one is return every row,
    // which is why an unbounded sweep must be unrepresentable here.
    const rows = await harness.base.client.$queryRaw<readonly unknown[]>`
      SELECT "id" FROM "public"."CredentialSecretVersion" LIMIT ALL
    `;
    expect(Array.isArray(rows)).toBe(true);
  });

  test("an Invalid Date is refused before the driver serialises NaN", async () => {
    expect(
      await refusalOf(() =>
        inTransaction((transaction) =>
          harness.repository.revokeCredential(
            credentialIdOf(liveCredentialId),
            new Date("not an instant"),
            transaction,
          ),
        ),
      ),
    ).toBe(INSTANT_NOT_REPRESENTABLE);
    // Past the guard, the DRIVER refuses it rather than the column: the value
    // never becomes SQL at all, so there is no SQLSTATE to compare against.
    await expect(
      harness.base.client.credential.update({
        where: { id: liveCredentialId },
        data: { revokedAt: new Date("not an instant") },
      }),
    ).rejects.toThrow();
  });
});
