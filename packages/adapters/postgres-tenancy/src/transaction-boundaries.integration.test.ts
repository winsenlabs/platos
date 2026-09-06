// WHAT A TRANSACTION BOUNDARY ACTUALLY DOES, MEASURED FROM OUTSIDE IT.
//
// `transaction.integration.test.ts` next door holds the three scope refusals —
// `not_open`, `scope_unknown`, `scope_foreign`. This file holds the four facts
// about the boundary itself that only a real server can settle, and every one of
// them is read back on a SECOND CONNECTION. "The row is not there when the
// writer looks again" proves nothing: a writer sees its own uncommitted rows.
// Durability and rollback are both claims about what SOMEBODY ELSE sees.
//
//   1. A RETURNED ERROR `Result` COMMITS. `UnitOfWork.run` commits when its
//      callback RESOLVES, and a `Result` failure is a resolved callback. This is
//      the `cost-monitoring` trap — its own `detect-crossings.ts` carries the
//      comment "REJECT, do not return. A returned error resolves the callback,
//      and a resolved callback commits" because the shape shipped once — and
//      nothing in the tree proved it against a database. It is proved here, so
//      the sentence is a measurement rather than a warning.
//
//   2. THE BRIDGE THAT CLOSES IT. `secrets`' own `inTransaction` turns a
//      `Result` failure into a rejection and the rejection into a rollback. The
//      SAME work under it leaves nothing behind. `secrets` is the only one of the
//      seventeen contexts that has this helper.
//
//   3. FAILURE INJECTION. Two writes, the second one refused by a real
//      constraint, and NEITHER row survives — including the first, which had
//      already succeeded.
//
//   4. A CAUGHT CONSTRAINT VIOLATION LEAVES THE TRANSACTION DEAD, AND THEN THE
//      COMMIT SAYS IT WORKED. PostgreSQL aborts a transaction on a violation and
//      the client opens no savepoint around a statement, so the next statement is
//      refused with SQLSTATE 25P02 whatever it is — and PostgreSQL then turns the
//      COMMIT of an aborted transaction into a ROLLBACK and reports success, so
//      `$transaction` RESOLVES and the caller is told the whole block landed
//      while every row in it was discarded. Both halves are measured here.
//      `channels-links.ts` already documents the first half from the other side
//      and deliberately reads nothing after its own catch; this is the
//      measurement that sentence was written from, and the second half is why
//      `secrets-variables.ts` inserts through `ON CONFLICT DO NOTHING` rather
//      than catching a violation at all.
//
// AND THE FIFTH SECTION IS TENANT ISOLATION UNDER THE AMBIENT FRAME, which is
// this dimension's own corner of it. The frame exists so a read JOINS the open
// transaction, and a frame that widened what a read can see would be a tenant
// boundary that holds on the pool and leaks inside a transaction. So: a scoped
// read inside tenant A's transaction still cannot reach tenant B's row when it
// is handed B's own identifiers; and a scoped DELETE cannot either, which is the
// asymmetry T7 found and closed.
//
// Excluded from `vitest run` by the package's `test` script and run by
// `pnpm test:postgres-tenancy:integration` in its own CI job. It FAILS when
// Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { inTransaction } from "@platos/context-secrets/application/index.js";
import type {
  EnvironmentId,
  EnvironmentVariable,
  Result,
} from "@platos/context-secrets/application/ports/index.js";
import { err } from "@platos/context-secrets/application/ports/index.js";
import { runResult } from "@platos/kernel";

import type { TenancyDatabaseClient } from "./client.js";
import { createTenancyDatabaseClient } from "./client.js";
import type { SecretsHarness } from "./secrets-harness.js";
import { AT, startSecretsHarness, variableIdOf } from "./secrets-harness.js";

let harness: SecretsHarness;
let environmentId: EnvironmentId;
let otherEnvironmentId: EnvironmentId;
/**
 * A client this adapter's pool never touched.
 *
 * Every durability and rollback assertion below reads through THIS, because the
 * writer's own connection can see its own uncommitted rows and would answer the
 * same whether the transaction committed or not.
 */
let onlooker: TenancyDatabaseClient;
let sequence = 0;

beforeAll(async () => {
  harness = await startSecretsHarness();
  environmentId = await harness.freshEnvironment();
  otherEnvironmentId = await harness.freshEnvironment();
  onlooker = createTenancyDatabaseClient({ databaseUrl: harness.base.databaseUrl });
}, 300_000);

afterAll(async () => {
  await onlooker?.$disconnect().catch(() => undefined);
  await harness?.stop();
});

function fresh(): string {
  sequence += 1;
  return `eeeeeeee-0007-4000-8000-${String(sequence).padStart(12, "0")}`;
}

/** Write one PLAIN variable through the canonical store. */
function write(
  scope: EnvironmentId,
  key: string,
  value: string,
  transaction: Parameters<typeof harness.variables.upsert>[1],
): Promise<Result<EnvironmentVariable>> {
  return harness.variables.upsert(
    {
      id: variableIdOf(fresh()),
      environmentId: scope,
      key,
      kind: "PLAIN",
      value,
      credentialId: null,
      lastUpdatedBy: null,
      at: AT,
      expectedVersion: null,
    },
    transaction,
  );
}

/** What the SECOND connection can see for a key. */
async function seenByAnother(scope: EnvironmentId, key: string): Promise<string | null> {
  const row = await onlooker.environmentVariable.findUnique({
    where: { environmentId_key: { environmentId: scope, key } },
    select: { value: true },
  });
  return row?.value ?? null;
}

describe("a returned error Result commits, and the bridge is what stops it", () => {
  test("UnitOfWork.run COMMITS work whose callback RESOLVED with a failure", async () => {
    const key = `RESOLVED_ERR_${fresh().slice(-4)}`;
    const outcome = await runResult(harness.base.adapter.unitOfWork, async (transaction) => {
      const written = await write(environmentId, key, "committed-anyway", transaction);
      expect(written).toMatchObject({ ok: true });
      // A LATER STEP FAILS, and says so the way a use case says so — by
      // RETURNING. Nothing throws, so the callback resolves, so the transaction
      // commits, so the write above is permanent. The failure is real and the
      // caller will be told about it; the rollback it implies never happens.
      return err({
        code: "SOMETHING_FAILED",
        kind: "conflict",
        message: "a later step failed",
      } as never) as Result<EnvironmentVariable>;
    });

    expect(outcome).toMatchObject({ ok: false });
    // THE TRAP, MEASURED. A connection that was never inside that transaction
    // can see the row.
    expect(await seenByAnother(environmentId, key)).toBe("committed-anyway");
  });

  test("the same work under `inTransaction` leaves NOTHING behind", async () => {
    const key = `BRIDGED_ERR_${fresh().slice(-4)}`;
    const outcome = await inTransaction(harness.base.adapter.unitOfWork, async (transaction) => {
      const written = await write(environmentId, key, "should-not-survive", transaction);
      expect(written).toMatchObject({ ok: true });
      return err({
        code: "SOMETHING_FAILED",
        kind: "conflict",
        message: "a later step failed",
      } as never) as Result<EnvironmentVariable>;
    });

    // The caller still sees a plain `Result` — the bridge does not change the
    // answer, only what the database did with the work behind it.
    expect(outcome).toMatchObject({ ok: false, error: { code: "SOMETHING_FAILED" } });
    expect(await seenByAnother(environmentId, key)).toBeNull();
  });

  test("and a SUCCESSFUL bridged transaction still commits — the negative control", async () => {
    const key = `BRIDGED_OK_${fresh().slice(-4)}`;
    const outcome = await inTransaction(harness.base.adapter.unitOfWork, (transaction) =>
      write(environmentId, key, "kept", transaction),
    );
    expect(outcome).toMatchObject({ ok: true });
    expect(await seenByAnother(environmentId, key)).toBe("kept");
  });
});

describe("failure injection: the second write fails and NEITHER row survives", () => {
  test("a real constraint refuses the second write, and the first is rolled back", async () => {
    const first = `INJECT_FIRST_${fresh().slice(-4)}`;
    // `enforce_win124_credential_kind` fires BEFORE INSERT and demands that a
    // named credential be in this environment, unrevoked, of kind
    // SECRET_REFERENCE and already pointing at an active version. A credential id
    // that names nothing satisfies none of it, so the second write is refused by
    // the DATABASE rather than by a guard this suite wrote — which is the whole
    // point of injecting the failure rather than throwing one.
    const absentCredential = fresh();

    await expect(
      runResult(harness.base.adapter.unitOfWork, async (transaction) => {
        const written = await write(environmentId, first, "written-first", transaction);
        expect(written).toMatchObject({ ok: true });
        return harness.variables.upsert(
          {
            id: variableIdOf(fresh()),
            environmentId,
            key: `INJECT_SECOND_${fresh().slice(-4)}`,
            kind: "SECRET",
            value: null,
            credentialId: variableIdOf(absentCredential) as never,
            lastUpdatedBy: null,
            at: AT,
            expectedVersion: null,
          },
          transaction,
        );
      }),
    ).rejects.toThrow();

    // THE FIRST WRITE HAD ALREADY SUCCEEDED, and it is gone. Read on the second
    // connection, because the writer's own would have been rolled back with it
    // and could not tell the difference.
    expect(await seenByAnother(environmentId, first)).toBeNull();
  });
});

describe("a caught constraint violation leaves the transaction unusable", () => {
  test("the statement after a caught SQLSTATE 23505 is refused with 25P02", async () => {
    const key = `POISON_${fresh().slice(-4)}`;
    const casualty = `POISON_CASUALTY_${fresh().slice(-4)}`;
    await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      write(environmentId, key, "held", transaction),
    );

    // Captured from INSIDE, because the transaction cannot survive to return
    // anything: once the server has aborted it, even the COMMIT is refused.
    let caughtViolation: string | null = null;
    let rawRecovery: string | null = null;
    let modelRecovery: string | null = null;

    const committed = await harness.base.client
      .$transaction(async (transaction) => {
        const held = await transaction.environmentVariable.findUniqueOrThrow({
          where: { environmentId_key: { environmentId, key } },
          select: { id: true },
        });
        // A GOOD WRITE FIRST, so there is something to lose.
        await transaction.environmentVariable.create({
          data: {
            id: fresh(),
            environmentId,
            key: casualty,
            kind: "PLAIN",
            value: "written-before-the-violation",
            version: 1,
            createdAt: AT,
            updatedAt: AT,
          },
        });
        try {
          // A duplicate of a row that is already there. The client reports P2002;
          // the SERVER has aborted the transaction.
          await transaction.environmentVariable.create({
            data: {
              id: fresh(),
              environmentId,
              key,
              kind: "PLAIN",
              value: "duplicate",
              version: 1,
              createdAt: AT,
              updatedAt: AT,
            },
          });
        } catch (error) {
          caughtViolation = (error as { readonly code?: string }).code ?? "<unclassified>";
        }
        // THE RECOVERY A CATCH LIKE THIS ALWAYS WANTS TO DO — read the row that
        // won — asked twice, because the two ways of asking answer differently
        // and only one of them tells an operator anything.
        try {
          await transaction.$queryRaw`SELECT id FROM "EnvironmentVariable" WHERE id = ${held.id}::uuid`;
        } catch (error) {
          rawRecovery =
            (error as { readonly meta?: { readonly code?: string } }).meta?.code ??
            "<unclassified>";
        }
        try {
          await transaction.environmentVariable.findUnique({ where: { id: held.id } });
        } catch (error) {
          const carrier = error as { readonly name?: string; readonly code?: string };
          modelRecovery = carrier.code ?? carrier.name ?? "<unclassified>";
        }
      })
      .then(
        () => true,
        () => false,
      );

    expect(caughtViolation).toBe("P2002");
    // THE SERVER'S OWN WORD FOR IT, through a raw statement: "current transaction
    // is aborted, commands ignored until end of transaction block".
    expect(rawRecovery).toBe("25P02");
    // AND THROUGH THE QUERY BUILDER IT HAS NO CODE AT ALL. The same abort
    // arrives as `PrismaClientUnknownRequestError` with `code` and `meta`
    // undefined, so a store that catches a violation and then reads cannot even
    // tell an operator WHY the read failed. Pinned as a fact, not endorsed.
    expect(modelRecovery).toBe("PrismaClientUnknownRequestError");
    // AND THE SHARPEST PART: `$transaction` RESOLVED. PostgreSQL turns a COMMIT
    // on an aborted transaction into a ROLLBACK and reports success, so the
    // client sees a clean commit and the caller is told the whole block landed.
    expect(committed).toBe(true);
    // It did not land. The write that had already succeeded before the violation
    // is not there, read on a connection that was never inside the transaction —
    // so "the transaction committed" and "the work was discarded" are both true
    // at once, and only the second one is about the data.
    expect(await seenByAnother(environmentId, casualty)).toBeNull();
    expect(await seenByAnother(environmentId, key)).toBe("held");
  });

  test("`ON CONFLICT DO NOTHING` conflicts WITHOUT killing the transaction", async () => {
    // The shape `secrets-variables.ts` uses for its insert half, and the reason
    // it does. The conflict is an empty result, the transaction survives it, and
    // the work that follows commits.
    const key = `NO_POISON_${fresh().slice(-4)}`;
    const survivor = `SURVIVOR_${fresh().slice(-4)}`;
    await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      write(environmentId, key, "held", transaction),
    );

    const outcome = await runResult(harness.base.adapter.unitOfWork, async (transaction) => {
      const refused = await write(environmentId, key, "duplicate", transaction);
      expect(refused).toMatchObject({
        ok: false,
        error: { code: "ENVIRONMENT_VARIABLE_VERSION_CONFLICT" },
      });
      // The transaction is still alive, which is the whole claim.
      return write(environmentId, survivor, "written-after", transaction);
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(await seenByAnother(environmentId, survivor)).toBe("written-after");
    expect(await seenByAnother(environmentId, key)).toBe("held");
  });
});

describe("tenant isolation holds INSIDE the ambient transaction frame", () => {
  test("a scoped read in tenant A's transaction cannot reach tenant B's row by key", async () => {
    const key = `TENANT_B_${fresh().slice(-4)}`;
    await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      write(otherEnvironmentId, key, "belongs-to-b", transaction),
    );

    const seen = await harness.base.adapter.unitOfWork.run(async (transaction) => {
      // A's own write first, so the frame is genuinely open and a read is
      // genuinely joining a transaction rather than falling through to the pool.
      await write(environmentId, `TENANT_A_${fresh().slice(-4)}`, "belongs-to-a", transaction);
      return {
        byKey: await harness.variables.findByKey(environmentId, key),
        // B's row IS reachable when B's own scope is named, which is what makes
        // the null above a scope decision rather than a missing row.
        withBsScope: await harness.variables.findByKey(otherEnvironmentId, key),
        listed: await harness.variables.list(environmentId),
      };
    });

    expect(seen.byKey).toEqual({ ok: true, value: null });
    expect(seen.withBsScope).toMatchObject({ ok: true, value: { value: "belongs-to-b" } });
    const listedKeys = seen.listed.ok ? seen.listed.value.map((variable) => variable.key) : [];
    expect(listedKeys).not.toContain(key);
  });

  test("a DELETE cannot reach another tenant's row even when its id is known", async () => {
    // THE ASYMMETRY T7 FOUND. `EnvironmentVariable.id` is a bare uuid primary
    // key with no tenant in it, and `remove` took the id ALONE — so a caller
    // holding another environment's variable id deleted that environment's row,
    // and the only thing that had ever stopped it was that the one caller in the
    // tree looked the id up in scope first. Every READ on this port named the
    // environment; this WRITE did not.
    const key = `CROSS_DELETE_${fresh().slice(-4)}`;
    const written = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      write(otherEnvironmentId, key, "belongs-to-b", transaction),
    );
    expect(written.ok).toBe(true);
    const victimId = written.ok ? written.value.id : variableIdOf(fresh());

    const removed = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      // Tenant A's scope, tenant B's id — the exact pair a leaked identifier
      // gives an attacker.
      harness.variables.remove(environmentId, victimId, transaction),
    );

    // `false`, NOT a refusal. An absent row and another tenant's row answer the
    // same, so this cannot be used to ask whether an id exists.
    expect(removed).toEqual({ ok: true, value: false });
    expect(await seenByAnother(otherEnvironmentId, key)).toBe("belongs-to-b");

    // AND THE NEGATIVE CONTROL: the owner deletes it, so the `false` above is a
    // scope decision and not a delete that never worked at all.
    const byOwner = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.variables.remove(otherEnvironmentId, victimId, transaction),
    );
    expect(byOwner).toEqual({ ok: true, value: true });
    expect(await seenByAnother(otherEnvironmentId, key)).toBeNull();
  });

  test("an UNCOMMITTED row is invisible to the second connection until it commits", async () => {
    const key = `UNCOMMITTED_${fresh().slice(-4)}`;
    let insideOwn: string | null = null;
    let insideOther: string | null = null;

    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await write(environmentId, key, "in-flight", transaction);
      // The ambient frame means this read JOINS the transaction and sees the row.
      const own = await harness.variables.findByKey(environmentId, key);
      insideOwn = own.ok && own.value !== null ? own.value.value : null;
      // The other connection is outside it and sees nothing.
      insideOther = await seenByAnother(environmentId, key);
    });

    expect(insideOwn).toBe("in-flight");
    expect(insideOther).toBeNull();
    expect(await seenByAnother(environmentId, key)).toBe("in-flight");
  });
});
