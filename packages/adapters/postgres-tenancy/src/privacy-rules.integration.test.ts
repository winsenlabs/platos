// The rules this port states in prose, held against the real database — the ones
// a conformance transcript cannot express because the double is structurally
// incapable of exhibiting them.
//
// FOUR OF THEM ARE ABOUT CONCURRENCY, and a single-threaded map cannot lose a
// race. `claimLease`'s own comment says "the check and the claim must be one
// operation or two resumes racing both see a free lease" — an assertion about
// what happens when two connections arrive at once, which is a property of
// PostgreSQL's row lock and not of any TypeScript this package contains.
//
// ONE IS ABOUT THE BARRIER NEVER OPENING, which is the rule this whole context
// exists for. "INSERT-THEN-EXTEND, never delete-then-insert. A re-seal on retry
// must not leave the barrier momentarily open, and a delete-then-insert does
// exactly that for the width of its own transaction." The width in question is
// the destructive pass, so the test is not "the row is there afterwards" — a
// delete-then-insert satisfies that — it is that NO DELETE IS SENT AT ALL, and
// that a second connection sees the alias sealed throughout.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  ErasureOperationId,
  ErasureTombstoneId,
  LeaseToken,
  SubjectKeyHash,
  TombstoneDraft,
} from "@platos/context-privacy/application/ports/index.js";
import { runResult } from "@platos/kernel";

import type { TenancyDatabaseClient } from "./client.js";
import type { PrivacyHarness, PrivacyTenant } from "./privacy-harness.js";
import { operationDraft, REQUESTED_AT, startPrivacyHarness } from "./privacy-harness.js";

let harness: PrivacyHarness;
let tenant: PrivacyTenant;
let foreign: PrivacyTenant;
/** A SECOND client over the same database. Nothing this adapter's pool touched. */
let observer: TenancyDatabaseClient;

const EXPIRES_AT = new Date("2026-06-01T09:00:00.000Z");
/**
 * The digest `operationDraft` mints, and therefore the digest every operation in
 * this suite carries.
 *
 * It is a CONSTANT here rather than a literal at each call site because the two
 * per-subject cases below are only meaningful if the rows they look for really
 * are the rows this suite wrote — a digest that matched nothing would make both
 * of them pass by returning zero on each side.
 */
const SUBJECT = "d0000001";

function id<Brand>(value: string): Brand {
  return value as Brand;
}

beforeAll(async () => {
  harness = await startPrivacyHarness();
  tenant = await harness.freshTenant();
  foreign = await harness.freshTenant();
  const { PrismaClient } = await import("@platos/tenancy-database");
  observer = new PrismaClient({
    datasources: { db: { url: harness.base.databaseUrl } },
  }) as TenancyDatabaseClient;
}, 300_000);

afterAll(async () => {
  await observer?.$disconnect();
  await harness?.stop();
});

function sealDraft(
  where: PrivacyTenant,
  aliasHash: string,
  operationId: string,
  expiresAt = EXPIRES_AT,
): TombstoneDraft {
  return {
    organizationId: where.organizationId,
    aliasHash: id(aliasHash),
    operationId: id<ErasureOperationId>(operationId),
    policyVersion: "privacy/1",
    sealedAt: REQUESTED_AT,
    expiresAt,
  };
}

describe("a lease may be taken by exactly one of two passes racing it", () => {
  test("two concurrent transactions claim, and precisely one wins", async () => {
    // `InMemoryPrivacyRepository.claimLease` is a compare-and-set over one map
    // entry in a single-threaded process, so it is UNLOSEABLE and this rule
    // cannot be exhibited against it at all. Here the two claims are two open
    // transactions on two connections, and the loser blocks on the winner's row
    // lock until it commits — which is exactly the mechanism the port asks for.
    const operationId = harness.base.freshId("00c0");
    await runResult(harness, (transaction) =>
      harness.repository.insertOperation(operationDraft(tenant, operationId), transaction),
    );

    let releaseFirst: () => void = () => undefined;
    const firstIsIn = new Promise<boolean>((resolveClaim) => {
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      void harness.run(async (transaction) => {
        const claimed = await harness.repository.claimLease(
          tenant.organizationId,
          id<ErasureOperationId>(operationId),
          { token: id<LeaseToken>("lease-first"), expiresAt: EXPIRES_AT },
          REQUESTED_AT,
          transaction,
        );
        resolveClaim(claimed.ok && claimed.value);
        await gate;
      });
    });

    expect(await firstIsIn).toBe(true);

    // The SECOND claim, from a genuinely separate transaction, issued while the
    // first still holds the row lock. It blocks; then the first commits and the
    // second's `where` re-evaluates against the row the first wrote.
    const secondClaim = runResult(harness, (transaction) =>
      harness.repository.claimLease(
        tenant.organizationId,
        id<ErasureOperationId>(operationId),
        { token: id<LeaseToken>("lease-second"), expiresAt: EXPIRES_AT },
        REQUESTED_AT,
        transaction,
      ),
    );
    releaseFirst();
    const second = await secondClaim;

    expect(second.ok).toBe(true);
    // `false` and NOT an error: somebody else won, which the port calls "a normal
    // outcome and not an error".
    expect(second.ok && second.value).toBe(false);

    const row = await observer.erasureOperation.findUnique({
      where: { id: operationId },
      select: { leaseToken: true },
    });
    expect(row?.leaseToken).toBe("lease-first");
  });

  test("an EXPIRED lease is reclaimable, at the exact instant it lapses", async () => {
    // `isLeaseFree` is `leaseExpiresAt <= now`, so a lease expiring exactly now is
    // FREE — the complement of `leaseUntil`, which always returns an instant
    // strictly after `now`. Reversing the comparison would leave a crashed pass's
    // lease held for one extra tick, and the boundary would be untestable at an
    // exact instant. This is that instant.
    const operationId = harness.base.freshId("00c1");
    await runResult(harness, (transaction) =>
      harness.repository.insertOperation(operationDraft(tenant, operationId), transaction),
    );
    await runResult(harness, (transaction) =>
      harness.repository.claimLease(
        tenant.organizationId,
        id<ErasureOperationId>(operationId),
        { token: id<LeaseToken>("lease-lapsing"), expiresAt: EXPIRES_AT },
        REQUESTED_AT,
        transaction,
      ),
    );
    const oneTickEarly = await runResult(harness, (transaction) =>
      harness.repository.claimLease(
        tenant.organizationId,
        id<ErasureOperationId>(operationId),
        { token: id<LeaseToken>("lease-early"), expiresAt: EXPIRES_AT },
        new Date(EXPIRES_AT.getTime() - 1),
        transaction,
      ),
    );
    const atExpiry = await runResult(harness, (transaction) =>
      harness.repository.claimLease(
        tenant.organizationId,
        id<ErasureOperationId>(operationId),
        { token: id<LeaseToken>("lease-late"), expiresAt: EXPIRES_AT },
        EXPIRES_AT,
        transaction,
      ),
    );
    expect(oneTickEarly.ok && oneTickEarly.value).toBe(false);
    expect(atExpiry.ok && atExpiry.value).toBe(true);
  });
});

describe("insert-then-extend, and the barrier that never opens", () => {
  test("a re-seal sends NO DELETE, which is the rule stated as a statement count", async () => {
    // The rule is not "the row is there afterwards" — a delete-then-insert
    // satisfies that too — it is that there is no instant at which the alias is
    // unsealed. The width of that instant would be the destructive pass, so the
    // only way to state it here is that no DELETE is issued at all.
    const operationId = harness.base.freshId("00c2");
    const alias = `a-reseal-${operationId.slice(-12)}`;
    await runResult(harness, (transaction) =>
      harness.repository.sealTombstones(
        [sealDraft(tenant, alias, operationId)],
        [id<ErasureTombstoneId>(harness.base.freshId("00c3"))],
        transaction,
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    harness.resetStatements();
    await runResult(harness, (transaction) =>
      harness.repository.sealTombstones(
        [sealDraft(tenant, alias, operationId, new Date("2026-07-01T09:00:00.000Z"))],
        [id<ErasureTombstoneId>(harness.base.freshId("00c4"))],
        transaction,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    const statements = harness.statements();
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((statement) => /\bDELETE\b/iu.test(statement))).toEqual([]);
    expect(statements.some((statement) => /\bUPDATE\b/iu.test(statement))).toBe(true);
  });

  test("the alias is sealed to a SECOND connection throughout the re-seal", async () => {
    // The same rule from the other side. The observer is a connection this
    // adapter's pool never touched, so what it can see is what any other process
    // in the installation can see — including the identity chokepoint whose write
    // the barrier exists to refuse.
    const operationId = harness.base.freshId("00c5");
    const alias = `a-throughout-${operationId.slice(-12)}`;
    await runResult(harness, (transaction) =>
      harness.repository.sealTombstones(
        [sealDraft(tenant, alias, operationId)],
        [id<ErasureTombstoneId>(harness.base.freshId("00c6"))],
        transaction,
      ),
    );

    const seenDuring: number[] = [];
    await harness.run(async (transaction) => {
      seenDuring.push(
        await observer.erasureTombstone.count({
          where: { organizationId: tenant.organizationId, aliasHash: alias },
        }),
      );
      await harness.repository.sealTombstones(
        [sealDraft(tenant, alias, operationId, new Date("2026-07-01T09:00:00.000Z"))],
        [id<ErasureTombstoneId>(harness.base.freshId("00c7"))],
        transaction,
      );
      seenDuring.push(
        await observer.erasureTombstone.count({
          where: { organizationId: tenant.organizationId, aliasHash: alias },
        }),
      );
    });
    seenDuring.push(
      await observer.erasureTombstone.count({
        where: { organizationId: tenant.organizationId, aliasHash: alias },
      }),
    );
    expect(seenDuring).toEqual([1, 1, 1]);
  });

  test("an extend moves the expiry and keeps the row's own identity and seal instant", async () => {
    const operationId = harness.base.freshId("00c8");
    const tombstoneId = harness.base.freshId("00c9");
    const alias = `a-extended-${operationId.slice(-12)}`;
    await runResult(harness, (transaction) =>
      harness.repository.sealTombstones(
        [sealDraft(tenant, alias, operationId)],
        [id<ErasureTombstoneId>(tombstoneId)],
        transaction,
      ),
    );
    const later = new Date("2026-07-01T09:00:00.000Z");
    const again = await runResult(harness, (transaction) =>
      harness.repository.sealTombstones(
        [sealDraft(tenant, alias, operationId, later)],
        [id<ErasureTombstoneId>(harness.base.freshId("00ca"))],
        transaction,
      ),
    );
    expect(again.ok && again.value).toEqual({ sealed: 0, extended: 1 });
    const found = await harness.repository.findActiveTombstones(
      tenant.organizationId,
      [id(alias)],
      REQUESTED_AT,
    );
    expect(found.ok && found.value).toHaveLength(1);
    const row = found.ok ? found.value[0] : undefined;
    // The id the FIRST seal minted, not the second's: the row was never replaced.
    expect(row?.tombstoneId).toBe(tombstoneId);
    expect(row?.sealedAt.toISOString()).toBe(REQUESTED_AT.toISOString());
    expect(row?.expiresAt.toISOString()).toBe(later.toISOString());
  });
});

describe("read-time expiry holds whether or not anything sweeps", () => {
  test("a lapsed row is still in the table and is NOT returned", async () => {
    // The port's requirement, in full: "the retention rule must hold whether or
    // not anything sweeps, so a row past its `expiresAt` MUST NOT be returned even
    // when it is still in the table". The second half is what the observer proves.
    const operationId = harness.base.freshId("00cb");
    const alias = `a-lapsed-${operationId.slice(-12)}`;
    await runResult(harness, (transaction) =>
      harness.repository.sealTombstones(
        [sealDraft(tenant, alias, operationId, new Date(REQUESTED_AT.getTime() + 1000))],
        [id<ErasureTombstoneId>(harness.base.freshId("00cc"))],
        transaction,
      ),
    );
    const after = new Date(REQUESTED_AT.getTime() + 2000);
    const found = await harness.repository.findActiveTombstones(
      tenant.organizationId,
      [id(alias)],
      after,
    );
    expect(found.ok && found.value).toHaveLength(0);
    // NOTHING SWEPT. The row is there; the read refused it.
    expect(
      await observer.erasureTombstone.count({
        where: { organizationId: tenant.organizationId, aliasHash: alias },
      }),
    ).toBe(1);
  });

  test("the purge deletes precisely the rows the read already refuses", async () => {
    // `hasElapsed` is `isActive`'s exact complement, so the sweep and the read
    // cannot disagree about the boundary instant. Both are pinned here at the
    // SAME instant, which is the only way that claim is falsifiable.
    const operationId = harness.base.freshId("00cd");
    const lapsed = `a-purge-lapsed-${operationId.slice(-12)}`;
    const live = `a-purge-live-${operationId.slice(-12)}`;
    const boundary = new Date(REQUESTED_AT.getTime() + 1000);
    await runResult(harness, (transaction) =>
      harness.repository.sealTombstones(
        [
          sealDraft(tenant, lapsed, operationId, boundary),
          sealDraft(tenant, live, operationId, new Date(boundary.getTime() + 1)),
        ],
        [
          id<ErasureTombstoneId>(harness.base.freshId("00ce")),
          id<ErasureTombstoneId>(harness.base.freshId("00cf")),
        ],
        transaction,
      ),
    );
    const readAtBoundary = await harness.repository.findActiveTombstones(
      tenant.organizationId,
      [id(lapsed), id(live)],
      boundary,
    );
    expect(readAtBoundary.ok && readAtBoundary.value.map((row) => String(row.aliasHash))).toEqual([live]);

    const purged = await runResult(harness, (transaction) =>
      harness.repository.purgeExpiredTombstones(boundary, transaction),
    );
    expect(purged.ok && purged.value).toBeGreaterThanOrEqual(1);
    expect(
      await observer.erasureTombstone.count({
        where: { organizationId: tenant.organizationId, aliasHash: lapsed },
      }),
    ).toBe(0);
    expect(
      await observer.erasureTombstone.count({
        where: { organizationId: tenant.organizationId, aliasHash: live },
      }),
    ).toBe(1);
  });
});

describe("every read is organization-scoped, and one deliberately is not", () => {
  test("an operation id that exists in another tenant reads as null, not as a row", async () => {
    const operationId = harness.base.freshId("00d0");
    await runResult(harness, (transaction) =>
      harness.repository.insertOperation(operationDraft(tenant, operationId), transaction),
    );
    const crossed = await harness.repository.findOperation(
      foreign.organizationId,
      id<ErasureOperationId>(operationId),
    );
    expect(crossed.ok && crossed.value).toBeNull();
    const own = await harness.repository.findOperation(
      tenant.organizationId,
      id<ErasureOperationId>(operationId),
    );
    expect(own.ok && own.value?.operationId).toBe(operationId);
  });

  test("a subject digest that exists in another tenant lists nothing", async () => {
    // The row is inserted HERE rather than relied on from another case. Two
    // organization-scoped reads both returning zero would pass this assertion for
    // the wrong reason — because the digest matched nothing anywhere — which is
    // exactly the vacuity a cross-tenant case is most prone to.
    await runResult(harness, (transaction) =>
      harness.repository.insertOperation(
        operationDraft(tenant, harness.base.freshId("00d2")),
        transaction,
      ),
    );
    const listed = await harness.repository.listOperationsForSubject(
      foreign.organizationId,
      id<SubjectKeyHash>(SUBJECT),
    );
    expect(listed.ok && listed.value).toHaveLength(0);
    const own = await harness.repository.listOperationsForSubject(
      tenant.organizationId,
      id<SubjectKeyHash>(SUBJECT),
    );
    expect(own.ok && own.value.length).toBeGreaterThan(0);
  });

  test("an update addressed with the WRONG organization is `not_found`, not a silent no-op", async () => {
    // The scope is in the `where` of the UPDATE, so a cross-tenant write affects
    // zero rows — and the store has to say so rather than return the caller's own
    // aggregate as though it had been written.
    const operationId = harness.base.freshId("00d1");
    await runResult(harness, (transaction) =>
      harness.repository.insertOperation(operationDraft(tenant, operationId), transaction),
    );
    const crossed = await runResult(harness, (transaction) =>
      harness.repository.updateProgress(
        foreign.organizationId,
        id<ErasureOperationId>(operationId),
        {
          workStatus: "SUCCEEDED",
          outcomes: [],
          legalHoldPolicyId: null,
          retryCount: 0,
          startedAt: REQUESTED_AT,
          completedAt: REQUESTED_AT,
          nextRetryAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
        },
        transaction,
      ),
    );
    expect(crossed.ok).toBe(false);
    expect(!crossed.ok && crossed.error.code).toBe("PRIVACY_OPERATION_NOT_FOUND");
    const row = await observer.erasureOperation.findUnique({
      where: { id: operationId },
      select: { status: true },
    });
    expect(row?.status).toBe("PENDING");
  });

  test("the queue's page crosses tenants ON PURPOSE, and the port says so", async () => {
    // `listDueOperations(asOf, limit)` takes no organization, unlike every other
    // read on this port. That is the one deliberate exception: it is the QUEUE's
    // page, and a queue that had to be told which tenant to drain would need a
    // tenant list nothing gives it. Every column it returns is already
    // content-free, so the widening carries no subject data across a boundary.
    //
    // TWO tenants, one due row each, and the assertion is that the page holds
    // BOTH. A page that held one would be indistinguishable from a page that was
    // scoped, and a page that held none would make the case vacuous.
    for (const where of [tenant, foreign]) {
      await runResult(harness, (transaction) =>
        harness.repository.insertOperation(
          operationDraft(where, harness.base.freshId("00d3"), { nextRetryAt: REQUESTED_AT }),
          transaction,
        ),
      );
    }
    const page = await harness.repository.listDueOperations(EXPIRES_AT, 100);
    expect(page.ok).toBe(true);
    const organizations = new Set(
      page.ok ? page.value.map((row) => String(row.organizationId)) : [],
    );
    expect(organizations.has(String(tenant.organizationId))).toBe(true);
    expect(organizations.has(String(foreign.organizationId))).toBe(true);
  });
});
