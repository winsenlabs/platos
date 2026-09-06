// TWO WRITERS RACING ONE ROW, AGAINST A REAL POSTGRESQL.
//
// THE FIRST CASE IS THE BUG, AND IT IS RUN RATHER THAN DESCRIBED. Two
// transactions each read `EnvironmentVariable` at version 1 and each write it
// with `version = version + 1`. Nothing is violated. PostgreSQL serializes the
// two UPDATEs on the row lock, applies them one after the other, and answers both
// with success — and the first writer's value is gone while it was told it had
// been stored. That is a LOST UPDATE, it is what this store did before WIN-258
// T7, and no in-memory double can produce it: the double is single-threaded and
// its `Map.set` cannot interleave.
//
// EVERY OTHER CASE IS THE SAME RACE WITH THE FENCE IN PLACE, and the fence is
// `input.expectedVersion` reaching the WHERE clause. The loser is refused with
// `ENVIRONMENT_VARIABLE_VERSION_CONFLICT`, the winner's value stands, and the
// row is at version 2 and not 3.
//
// THE RACES ARE REAL AND ORDERED, NOT SIMULATED. Each fenced case opens two
// transactions through `UnitOfWork.run` — which puts each in its own
// `AsyncLocalStorage` frame on its own pooled connection — and drives them across
// a pair of gates so the interleaving is the one the case claims and not the one
// the event loop happened to pick. The unfenced case opens its two through
// `$transaction` on the pooled client instead, because the statement it is
// demonstrating is the one the store sent BEFORE the fence and no store sends it
// any more.
//
// AND EACH ONE OBSERVES THE WAIT RATHER THAN ASSUMING IT. A grace period two
// orders of magnitude longer than the write takes, then a snapshot: a second
// writer that had already settled never met the first one's row lock, and the
// case would be proving nothing about concurrency at all.
//
// AND THE NEGATIVE CONTROL IS NOT OPTIONAL. A fence that refuses every second
// write is as wrong as no fence and just as green, so two writers on two
// DIFFERENT keys must both commit, and a writer whose version is current must be
// applied rather than refused.
//
// Excluded from `vitest run` by the package's `test` script and run by
// `pnpm test:postgres-tenancy:integration` in its own CI job. It FAILS when
// Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  EnvironmentId,
  EnvironmentVariable,
  Result,
  TransactionScope,
} from "@platos/context-secrets/application/ports/index.js";
import { runResult } from "@platos/context-secrets/application/ports/index.js";

import type { SecretsHarness } from "./secrets-harness.js";
import { AT, LATER, startSecretsHarness, variableIdOf } from "./secrets-harness.js";

let harness: SecretsHarness;
let environmentId: EnvironmentId;
let sequence = 0;

beforeAll(async () => {
  harness = await startSecretsHarness();
  environmentId = await harness.freshEnvironment();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

/** A fresh uuid, so no two cases collide on a key or an id. */
function fresh(): string {
  sequence += 1;
  return `dddddddd-0007-4000-8000-${String(sequence).padStart(12, "0")}`;
}

/** A deferred, so a transaction can be held open until a case releases it. */
function gate(): { readonly wait: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Long enough that a write which does not queue would certainly have landed. */
const GRACE_MS = 400;

const settle = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/** Seed one PLAIN variable at version 1 and answer its row id. */
async function seed(key: string, value: string): Promise<string> {
  const id = fresh();
  const written = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
    harness.variables.upsert(
      {
        id: variableIdOf(id),
        environmentId,
        key,
        kind: "PLAIN",
        value,
        credentialId: null,
        lastUpdatedBy: null,
        at: AT,
        expectedVersion: null,
      },
      transaction,
    ),
  );
  expect(written).toMatchObject({ ok: true, value: { version: 1 } });
  return id;
}

/** The row as it stands, read on the pool rather than in anybody's transaction. */
async function stored(key: string): Promise<{ id: string; value: string | null; version: number }> {
  const row = await harness.base.client.environmentVariable.findUniqueOrThrow({
    where: { environmentId_key: { environmentId, key } },
    select: { id: true, value: true, version: true },
  });
  return row;
}

function write(
  key: string,
  value: string,
  expectedVersion: number | null,
  transaction: TransactionScope,
): Promise<Result<EnvironmentVariable>> {
  return harness.variables.upsert(
    {
      id: variableIdOf(fresh()),
      environmentId,
      key,
      kind: "PLAIN",
      value,
      credentialId: null,
      lastUpdatedBy: null,
      at: LATER,
      expectedVersion,
    },
    transaction,
  );
}

describe("the lost update this fence exists to stop", () => {
  test("two UNFENCED writers both commit, and the first one's value is gone", async () => {
    // THE STORE IS NOT USED HERE, ON PURPOSE. This is the statement the store
    // sent before the fence — `SET value = …, version = version + 1` keyed on the
    // row and on nothing else — so the case shows what the DATABASE does with it
    // rather than what a store does. Both writers succeed; nothing is refused.
    const key = `LOST_${fresh().slice(-4)}`;
    await seed(key, "one");
    const trace: string[] = [];
    const held = gate();

    // TWO REAL INTERACTIVE TRANSACTIONS on the pooled client, each doing the
    // read-then-write the use case does. `A` reads and then waits, so both have
    // read version 1 before either writes.
    const writer = (value: string, label: string, wait: boolean): Promise<void> =>
      harness.base.client.$transaction(
        async (transaction) => {
          const read = await transaction.environmentVariable.findUniqueOrThrow({
            where: { environmentId_key: { environmentId, key } },
            select: { version: true },
          });
          trace.push(`${label}:read:${read.version}`);
          if (wait) await held.wait;
          await transaction.$executeRaw`
            UPDATE "EnvironmentVariable"
            SET value = ${value}, version = version + 1, "updatedAt" = now()
            WHERE "environmentId" = ${environmentId}::uuid AND key = ${key}
          `;
          trace.push(`${label}:wrote`);
        },
        { timeout: 20_000 },
      );

    const a = writer("three", "A", true);
    await settle(GRACE_MS / 2);
    const b = writer("two", "B", false);
    await b;
    held.open();
    await a;

    // BOTH SAW VERSION 1, AND BOTH WROTE. Neither was told anything was wrong.
    expect(trace.filter((entry) => entry.endsWith(":read:1"))).toHaveLength(2);
    expect(trace.filter((entry) => entry.endsWith(":wrote"))).toHaveLength(2);
    const after = await stored(key);
    // Version 3 is the tell: two increments landed on a row two callers each
    // believed they were the only writer of, and one of the two values is
    // nowhere.
    expect(after.version).toBe(3);
    expect(after.value).toBe("three");
  });
});

describe("the fence, across two real concurrent transactions", () => {
  test("the writer that read the STALE version is refused, and the winner stands", async () => {
    const key = `FENCED_${fresh().slice(-4)}`;
    const seeded = await seed(key, "one");
    const trace: string[] = [];
    const winnerWrote = gate();
    const winnerMayCommit = gate();

    const winner = runResult(harness.base.adapter.unitOfWork, async (transaction) => {
      const answer = await write(key, "winner", 1, transaction);
      trace.push(`winner:${answer.ok ? "ok" : answer.error.code}`);
      winnerWrote.open();
      // HELD OPEN. The loser's UPDATE must meet a row this transaction has locked
      // and has not yet committed, which is the only interleaving where the two
      // are genuinely racing rather than merely consecutive.
      await winnerMayCommit.wait;
      return answer;
    });

    await winnerWrote.wait;
    let loserSettled = false;
    const loser = runResult(harness.base.adapter.unitOfWork, async (transaction) => {
      // The SAME version the winner read. This is a caller that read the row
      // before the winner wrote it and is only now getting to its write.
      const answer = await write(key, "loser", 1, transaction);
      loserSettled = true;
      trace.push(`loser:${answer.ok ? "ok" : answer.error.code}`);
      return answer;
    });

    // IT MUST STILL BE WAITING. A generous grace period, then the snapshot: if
    // the loser had already settled here, its UPDATE never met the winner's row
    // lock and the case would be proving nothing about concurrency at all.
    await settle(GRACE_MS);
    expect(loserSettled).toBe(false);
    trace.push("winner:committing");
    winnerMayCommit.open();

    const [winnerAnswer, loserAnswer] = await Promise.all([winner, loser]);
    expect(winnerAnswer).toMatchObject({ ok: true, value: { value: "winner", version: 2 } });
    expect(loserAnswer).toMatchObject({
      ok: false,
      error: { code: "ENVIRONMENT_VARIABLE_VERSION_CONFLICT" },
    });
    // THE ORDER IS THE CLAIM. The loser resolved only after the winner released
    // its transaction, which is what "it waited" means.
    expect(trace).toEqual([
      "winner:ok",
      "winner:committing",
      "loser:ENVIRONMENT_VARIABLE_VERSION_CONFLICT",
    ]);

    // ONE increment, the winner's value, and the row the seed created.
    expect(await stored(key)).toEqual({ id: seeded, value: "winner", version: 2 });
  });

  test("the loser's OWN earlier work in the same transaction rolls back with it", async () => {
    // THE POINT OF ANSWERING `Result` RATHER THAN SWALLOWING THE RACE. A losing
    // `setEnvironmentVariable` has already rotated the credential behind the key
    // by the time it reaches the write, and that rotation must not commit for a
    // variable that was never stored. `inTransaction` is what turns the returned
    // failure into a rollback; here the same shape is exercised with a plain
    // second row standing in for the rotation, so the case tests the boundary
    // rather than the vault.
    const key = `ROLLBACK_${fresh().slice(-4)}`;
    const companion = `COMPANION_${fresh().slice(-4)}`;
    await seed(key, "one");
    await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      write(key, "moved-on", 1, transaction),
    );

    class Abort extends Error {
      constructor(readonly answer: Result<EnvironmentVariable>) {
        super("abort");
      }
    }

    const outcome = await runResult(
      harness.base.adapter.unitOfWork, async (transaction) => {
        // Work that succeeds, first — a row this transaction owns outright.
        const earlier = await write(companion, "written-first", null, transaction);
        expect(earlier).toMatchObject({ ok: true });
        const answer = await write(key, "stale", 1, transaction);
        if (!answer.ok) throw new Abort(answer);
        return answer;
      })
      .catch((thrown: unknown) => (thrown instanceof Abort ? thrown.answer : Promise.reject(thrown)));

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "ENVIRONMENT_VARIABLE_VERSION_CONFLICT" },
    });
    // NEITHER ROW SURVIVES — read on the pool, which is the only connection that
    // could not have seen the rolled-back transaction's own uncommitted state.
    expect(
      await harness.base.client.environmentVariable.findUnique({
        where: { environmentId_key: { environmentId, key: companion } },
      }),
    ).toBeNull();
    expect(await stored(key)).toMatchObject({ value: "moved-on", version: 2 });
  });

  test("two writers who both read NO ROW race the unique index, and exactly one lands", async () => {
    // The same lost update wearing the shape of an insert. Both callers read
    // nothing for this key, so both offer `expectedVersion: null`; the compound
    // unique is the fence, and `ON CONFLICT DO NOTHING` turns the loser's write
    // into an empty result rather than into a violation that would abort its
    // transaction.
    const key = `INSERT_RACE_${fresh().slice(-4)}`;
    const winnerWrote = gate();
    const winnerMayCommit = gate();

    const winner = runResult(harness.base.adapter.unitOfWork, async (transaction) => {
      const answer = await write(key, "winner", null, transaction);
      winnerWrote.open();
      await winnerMayCommit.wait;
      return answer;
    });
    await winnerWrote.wait;

    let loserSettled = false;
    const loser = runResult(harness.base.adapter.unitOfWork, async (transaction) => {
      const answer = await write(key, "loser", null, transaction);
      loserSettled = true;
      return answer;
    });
    await settle(GRACE_MS);
    // THE INSERT QUEUES TOO. `ON CONFLICT DO NOTHING` still has to wait on the
    // uncommitted row's index entry to learn whether there is a conflict at all.
    expect(loserSettled).toBe(false);
    winnerMayCommit.open();

    const [winnerAnswer, loserAnswer] = await Promise.all([winner, loser]);
    expect(winnerAnswer).toMatchObject({ ok: true, value: { value: "winner", version: 1 } });
    expect(loserAnswer).toMatchObject({
      ok: false,
      error: { code: "ENVIRONMENT_VARIABLE_VERSION_CONFLICT" },
    });
    const rows = await harness.base.client.environmentVariable.findMany({
      where: { environmentId, key },
      select: { value: true },
    });
    expect(rows).toEqual([{ value: "winner" }]);
  });
});

describe("the negative controls: the fence is per row, and lets current writers through", () => {
  test("a writer whose version IS current is applied", async () => {
    const key = `CURRENT_${fresh().slice(-4)}`;
    await seed(key, "one");
    const answer = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      write(key, "two", 1, transaction),
    );
    expect(answer).toMatchObject({ ok: true, value: { value: "two", version: 2 } });
  });

  test("two concurrent writers on DIFFERENT keys do not queue and both commit", async () => {
    const left = `LEFT_${fresh().slice(-4)}`;
    const right = `RIGHT_${fresh().slice(-4)}`;
    await seed(left, "one");
    await seed(right, "one");
    const leftWrote = gate();
    const leftMayCommit = gate();

    const first = runResult(harness.base.adapter.unitOfWork, async (transaction) => {
      const answer = await write(left, "left-two", 1, transaction);
      leftWrote.open();
      await leftMayCommit.wait;
      return answer;
    });
    await leftWrote.wait;

    let secondSettled = false;
    const second = runResult(harness.base.adapter.unitOfWork, async (transaction) => {
      const answer = await write(right, "right-two", 1, transaction);
      secondSettled = true;
      return answer;
    });
    await settle(GRACE_MS);
    // IT DID NOT WAIT, which is the whole control: `FOR UPDATE`-shaped
    // serialization on the wrong key would make every writer in an environment
    // queue behind every other.
    expect(secondSettled).toBe(true);
    leftMayCommit.open();

    expect(await Promise.all([first, second])).toMatchObject([
      { ok: true, value: { value: "left-two", version: 2 } },
      { ok: true, value: { value: "right-two", version: 2 } },
    ]);
  });
});
