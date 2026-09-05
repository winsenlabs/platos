// THE LOCKS ACTUALLY BLOCK — proved by making something wait.
//
// A lock port is the easiest guard in a repository to ship decoratively. Every
// method returns, every value is right, and the only way to tell a real
// `FOR UPDATE` from a `SELECT` that dropped it is to run two transactions at
// once and watch the second one WAIT. That is what this suite does: it records
// what happened across two concurrent transactions and requires the second
// acquisition to land AFTER the first commit, not merely to return the right
// boolean.
//
// THE GAP IS OBSERVED, NOT ASSUMED. Each case gives the blocked transaction a
// real chance to acquire — a timer two orders of magnitude longer than the
// statement takes — and takes a snapshot of the trace BEFORE the holder commits
// as well as after. Without that snapshot the suite would pass against a lock
// that never blocks, because the two transactions would still finish in whatever
// order the event loop scheduled them.
//
// EVERY CASE HAS ITS NEGATIVE CONTROL. A lock that blocks everything is as wrong
// as one that blocks nothing and is just as green: `FOR UPDATE` is a ROW lock and
// the advisory key carries the ADDRESS, so two transactions over two different
// organizations, and two invitees of one organization, must NOT queue.
//
// AND THE FENCE, which is the other half of `lockEnvironmentForUpdate` and the
// reason ADR M0.3 §15 was argued the way it was. The last cases run the REAL
// `revokeAccessKeyGeneration` use case twice, concurrently, on the same
// snapshot — once with the adapter's lock and once with a lock that has had
// `FOR UPDATE` taken out of it. With the lock exactly one commits and the other
// is refused as superseded; without it both commit, which is the resurrection of
// a revoked access key the counter exists to stop.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createRevokeAccessKeyGeneration } from "@platos/context-tenancy/application/index.js";
import type {
  EnvironmentAccessKeyRevocationCounter,
  EnvironmentId,
  TenancyLocks,
  TransactionScope,
} from "@platos/context-tenancy/application/ports/index.js";

import { emailOf, envId, orgId } from "./harness.js";
import { startPortsHarness, type PortsHarness } from "./ports-harness.js";

let harness: PortsHarness;

/** Long enough that a lock which does not block would certainly have acquired. */
const GRACE_MS = 400;

const settle = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/** A deferred, so a transaction can be held open until a case releases it. */
function gate(): { readonly wait: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

interface RaceTrace {
  /** The trace as it stood while the first transaction still held the lock. */
  readonly whileHeld: readonly string[];
  /** The trace after the first transaction committed and the second finished. */
  readonly afterRelease: readonly string[];
}

/**
 * Run `take` in two concurrent transactions and record what happened.
 *
 * The first holds its lock until the case releases the gate. `whileHeld` is the
 * load-bearing half: a lock that does not block puts `second-acquired` there.
 */
async function raceForLock(
  take: (transaction: TransactionScope) => Promise<unknown>,
): Promise<RaceTrace> {
  const trace: string[] = [];
  const held = gate();
  const acquired = gate();

  const first = harness.adapter.unitOfWork.run(async (transaction) => {
    await take(transaction);
    trace.push("first-acquired");
    acquired.open();
    await held.wait;
    trace.push("first-committed");
  });

  await acquired.wait;
  const second = harness.adapter.unitOfWork.run(async (transaction) => {
    trace.push("second-attempted");
    await take(transaction);
    trace.push("second-acquired");
  });

  await settle(GRACE_MS);
  const whileHeld = [...trace];
  held.open();
  await Promise.all([first, second]);
  return { whileHeld, afterRelease: [...trace] };
}

/**
 * A meeting point the two rotations of the fence cases pass through.
 *
 * `arrive` resolves as soon as BOTH callers have reached it, or after
 * `timeoutMs` if only one ever does. That asymmetry is what makes both fence
 * cases deterministic rather than dependent on scheduling: with the row lock the
 * second rotation cannot reach its read at all, so the first waits out the
 * timeout, commits, and the second then observes a moved generation; without the
 * lock both reach it, both are released at once, and both find their snapshot
 * current. Nothing about the rendezvous is in the code under test — it sits in a
 * wrapper around the counter's `read`, and BOTH cases use the same wrapper, so
 * the only difference between them is the lock.
 */
function rendezvous(expected: number, timeoutMs: number): () => Promise<void> {
  let arrived = 0;
  const everyone = gate();
  return async (): Promise<void> => {
    arrived += 1;
    if (arrived >= expected) {
      everyone.open();
      return;
    }
    await Promise.race([everyone.wait, settle(timeoutMs)]);
  };
}

function countingThrough(
  counter: EnvironmentAccessKeyRevocationCounter,
  arrive: () => Promise<void>,
): EnvironmentAccessKeyRevocationCounter {
  return {
    async read(environmentId: EnvironmentId): Promise<number | null> {
      const observed = await counter.read(environmentId);
      await arrive();
      return observed;
    },
    bump: (environmentId, transaction) => counter.bump(environmentId, transaction),
  };
}

beforeAll(async () => {
  harness = await startPortsHarness();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("lockOrganizationForUpdate", () => {
  test("serializes two transactions over one organization", async () => {
    const organizationId = await harness.seedOrganization("lock-org");
    const trace = await raceForLock((transaction) =>
      harness.ports.locks.lockOrganizationForUpdate(orgId(organizationId), transaction),
    );
    expect(trace.whileHeld).toEqual(["first-acquired", "second-attempted"]);
    expect(trace.afterRelease).toEqual([
      "first-acquired",
      "second-attempted",
      "first-committed",
      "second-acquired",
    ]);
  }, 60_000);

  test("does NOT serialize two transactions over different organizations", async () => {
    // The negative control on the case above. `FOR UPDATE` is a ROW lock, so two
    // transactions over two organizations must both proceed — and if this ever
    // showed the blocking ordering, the "lock" would be a table lock and the
    // first case's evidence would be worthless.
    const one = await harness.seedOrganization("lock-org-a");
    const other = await harness.seedOrganization("lock-org-b");
    const trace: string[] = [];
    const held = gate();
    const acquired = gate();
    const first = harness.adapter.unitOfWork.run(async (transaction) => {
      await harness.ports.locks.lockOrganizationForUpdate(orgId(one), transaction);
      trace.push("first-acquired");
      acquired.open();
      await held.wait;
    });
    await acquired.wait;
    await harness.adapter.unitOfWork.run(async (transaction) => {
      await harness.ports.locks.lockOrganizationForUpdate(orgId(other), transaction);
      trace.push("second-acquired");
    });
    held.open();
    await first;
    expect(trace).toEqual(["first-acquired", "second-acquired"]);
  }, 60_000);

  test("refuses an archived organization, and locks nothing while doing it", async () => {
    // `false` AND no blocking. The row EXISTS, so a statement that dropped the
    // `archivedAt IS NULL` clause would lock it and return true; a statement that
    // kept the clause matches no row and takes no lock at all. Both halves are
    // asserted, because either alone passes against the wrong statement.
    const archivedId = await harness.seedOrganization("lock-org-archived", true);
    const trace: string[] = [];
    const held = gate();
    const acquired = gate();
    const first = harness.adapter.unitOfWork.run(async (transaction) => {
      trace.push(
        `first:${String(
          await harness.ports.locks.lockOrganizationForUpdate(orgId(archivedId), transaction),
        )}`,
      );
      acquired.open();
      await held.wait;
    });
    await acquired.wait;
    await harness.adapter.unitOfWork.run(async (transaction) => {
      trace.push(
        `second:${String(
          await harness.ports.locks.lockOrganizationForUpdate(orgId(archivedId), transaction),
        )}`,
      );
    });
    held.open();
    await first;
    expect(trace).toEqual(["first:false", "second:false"]);
  }, 60_000);

  test("refuses an organization that does not exist", async () => {
    await expect(
      harness.adapter.unitOfWork.run((transaction) =>
        harness.ports.locks.lockOrganizationForUpdate(
          orgId(harness.freshId("0116")),
          transaction,
        ),
      ),
    ).resolves.toBe(false);
  }, 60_000);
});

describe("lockInvitationSlot", () => {
  test("serializes two transactions over one (organization, email) slot", async () => {
    const organizationId = await harness.seedOrganization("lock-slot");
    const trace = await raceForLock((transaction) =>
      harness.ports.locks.lockInvitationSlot(
        orgId(organizationId),
        emailOf("invitee@ports.test"),
        transaction,
      ),
    );
    expect(trace.whileHeld).toEqual(["first-acquired", "second-attempted"]);
    expect(trace.afterRelease).toEqual([
      "first-acquired",
      "second-attempted",
      "first-committed",
      "second-acquired",
    ]);
  }, 60_000);

  test("does NOT serialize two different addresses in one organization", async () => {
    // The key is `organization-invitation:<org>:<email>`, so two invitees of one
    // organization must not queue behind each other. A key that dropped the
    // address — an easy simplification, since the organization is the thing being
    // written — would turn every invitation in a tenant into one queue, and this
    // case is what says so.
    const organizationId = await harness.seedOrganization("lock-slot-two");
    const trace: string[] = [];
    const held = gate();
    const acquired = gate();
    const first = harness.adapter.unitOfWork.run(async (transaction) => {
      await harness.ports.locks.lockInvitationSlot(
        orgId(organizationId),
        emailOf("one@ports.test"),
        transaction,
      );
      trace.push("first-acquired");
      acquired.open();
      await held.wait;
    });
    await acquired.wait;
    await harness.adapter.unitOfWork.run(async (transaction) => {
      await harness.ports.locks.lockInvitationSlot(
        orgId(organizationId),
        emailOf("other@ports.test"),
        transaction,
      );
      trace.push("second-acquired");
    });
    held.open();
    await first;
    expect(trace).toEqual(["first-acquired", "second-acquired"]);
  }, 60_000);

  test("is released by the transaction, including by a rollback", async () => {
    // `pg_advisory_xact_lock`, not the session form. A session lock taken on a
    // pooled connection outlives the caller and leaks into whoever is handed that
    // connection next; this case takes the lock in a transaction that THROWS and
    // then takes it again, which would hang for the whole case timeout if the
    // lock had leaked.
    const organizationId = await harness.seedOrganization("lock-slot-rollback");
    await expect(
      harness.adapter.unitOfWork.run(async (transaction) => {
        await harness.ports.locks.lockInvitationSlot(
          orgId(organizationId),
          emailOf("rollback@ports.test"),
          transaction,
        );
        throw new Error("deliberate rollback");
      }),
    ).rejects.toThrow("deliberate rollback");
    await expect(
      harness.adapter.unitOfWork.run((transaction) =>
        harness.ports.locks.lockInvitationSlot(
          orgId(organizationId),
          emailOf("rollback@ports.test"),
          transaction,
        ),
      ),
    ).resolves.toBeUndefined();
  }, 60_000);
});

describe("lockEnvironmentForUpdate and the access-key revocation fence", () => {
  test("serializes two transactions over one environment", async () => {
    const organizationId = await harness.seedOrganization("lock-env");
    const environmentId = await harness.seedEnvironment(organizationId, "lock-env-prod");
    const trace = await raceForLock((transaction) =>
      harness.ports.locks.lockEnvironmentForUpdate(envId(environmentId), transaction),
    );
    expect(trace.whileHeld).toEqual(["first-acquired", "second-attempted"]);
    expect(trace.afterRelease).toEqual([
      "first-acquired",
      "second-attempted",
      "first-committed",
      "second-acquired",
    ]);
  }, 60_000);

  test("the fence holds: two rotations on one snapshot, exactly one commits", async () => {
    const organizationId = await harness.seedOrganization("fence-held");
    const environmentId = envId(await harness.seedEnvironment(organizationId, "fence-held-prod"));
    // THE REAL USE CASE, not a re-derivation of it in this file. What is under
    // test is the composition `revokeAccessKeyGeneration` performs — lock, read,
    // compare, bump — over these ports.
    const revoke = createRevokeAccessKeyGeneration({
      accessKeyRevocation: countingThrough(
        harness.ports.accessKeyRevocation,
        rendezvous(2, GRACE_MS),
      ),
      locks: harness.ports.locks,
      unitOfWork: harness.adapter.unitOfWork,
    });
    const [left, right] = await Promise.all([
      revoke({ environmentId, expectedGeneration: 0 }),
      revoke({ environmentId, expectedGeneration: 0 }),
    ]);
    const outcomes = [left, right]
      .map((result) => (result.ok ? `ok:${String(result.value)}` : `err:${result.error.code}`))
      .sort();
    expect(outcomes).toEqual(["err:TENANCY_ACCESS_KEY_GENERATION_SUPERSEDED", "ok:1"]);
    // And the counter moved exactly once, so the loser wrote nothing.
    expect(await harness.ports.accessKeyRevocation.read(environmentId)).toBe(1);
  }, 60_000);

  test("without FOR UPDATE the same two rotations BOTH commit", async () => {
    // THE NEGATIVE CONTROL that makes the case above evidence rather than a
    // coincidence of scheduling. The rendezvous, the counter and the use case are
    // identical; the ONLY difference is the statement — the same existence check
    // with the row lock taken out. Both rotations then read generation 0, both
    // find their snapshot current, and both bump, which is exactly the superseded
    // rotation the fence exists to refuse and is invisible to every value the
    // ports return.
    const organizationId = await harness.seedOrganization("fence-dropped");
    const environmentId = envId(
      await harness.seedEnvironment(organizationId, "fence-dropped-prod"),
    );
    const decorative: TenancyLocks = {
      ...harness.ports.locks,
      async lockEnvironmentForUpdate(
        target: EnvironmentId,
        _transaction: TransactionScope,
      ): Promise<boolean> {
        const rows = await harness.client.$queryRawUnsafe<readonly { id: string }[]>(
          `SELECT id FROM "Environment" WHERE id = $1::uuid`,
          target,
        );
        return rows.length === 1;
      },
    };
    const revoke = createRevokeAccessKeyGeneration({
      accessKeyRevocation: countingThrough(
        harness.ports.accessKeyRevocation,
        rendezvous(2, GRACE_MS),
      ),
      locks: decorative,
      unitOfWork: harness.adapter.unitOfWork,
    });
    const [left, right] = await Promise.all([
      revoke({ environmentId, expectedGeneration: 0 }),
      revoke({ environmentId, expectedGeneration: 0 }),
    ]);
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    expect(await harness.ports.accessKeyRevocation.read(environmentId)).toBe(2);
  }, 60_000);

  test("the increment is monotonic under concurrency even with no snapshot", async () => {
    // Sixteen unconditional bumps at once. The counter is `x + 1` computed BY
    // PostgreSQL, so every one of them must land and each must see a distinct
    // value: a read-modify-write in this process would lose updates and the final
    // value would be less than sixteen.
    const organizationId = await harness.seedOrganization("fence-monotonic");
    const environmentId = envId(
      await harness.seedEnvironment(organizationId, "fence-monotonic-prod"),
    );
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        harness.adapter.unitOfWork.run((transaction) =>
          harness.ports.accessKeyRevocation.bump(environmentId, transaction),
        ),
      ),
    );
    expect([...results].sort((left, right) => left - right)).toEqual(
      Array.from({ length: 16 }, (_unused, index) => index + 1),
    );
    expect(await harness.ports.accessKeyRevocation.read(environmentId)).toBe(16);
  }, 120_000);

  test("reads a row written before the fence migration as generation 0, not null", async () => {
    // EXPAND/CONTRACT. `accessKeyRevocationVersion` arrived in
    // `20260825070000_access_key_revocation_fence` with a backfill and a DEFAULT,
    // so a row an older release wrote reads back as 0. Null means "no such
    // environment" and nothing else, and this case is the difference: a `?? 0` in
    // the reader would let a rotation snapshot 0 for an environment that is not
    // there.
    const organizationId = await harness.seedOrganization("fence-legacy");
    const legacyId = envId(await harness.seedPreFenceEnvironment(organizationId, "fence-legacy-e"));
    expect(await harness.ports.accessKeyRevocation.read(legacyId)).toBe(0);
    expect(await harness.ports.accessKeyRevocation.read(envId(harness.freshId("0115")))).toBeNull();
    await harness.adapter.unitOfWork.run((transaction) =>
      harness.ports.accessKeyRevocation.bump(legacyId, transaction),
    );
    expect(await harness.ports.accessKeyRevocation.read(legacyId)).toBe(1);
  }, 60_000);
});
