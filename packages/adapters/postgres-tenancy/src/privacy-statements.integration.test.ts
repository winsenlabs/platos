// Statement counts for the `privacy` store, MEASURED — the N+1 control.
//
// Every pin below is a number this suite observed rather than a number somebody
// expected, and every read is measured TWICE: once over a small fixture and once
// over one an order of magnitude larger. What matters is not the figure but that
// the figure DOES NOT MOVE with the number of rows. An N+1 does not announce
// itself in a suite — every value is correct and every test passes — it announces
// itself as a barrier check that took four seconds because the person had forty
// aliases.
//
// *** AND ON THIS PORT THE ALIAS SET IS THE WHOLE RISK. *** `sealTombstones` is
// handed one row per identity channel the subject was ever reachable on, and it
// runs INSIDE the transaction that is holding the destruction open. A per-alias
// upsert loop would be correct, would pass every other suite in this directory,
// and would put an O(aliases) round trip in the one place this system cannot
// afford one. The pins below are three aliases and thirty, and they are the same
// number.
//
// THE PROBE FILTER IS ANCHORED, AND THE ANCHOR IS THE POINT. The driver's
// connection probe is exactly `SELECT 1`, and a filter written as a SUBSTRING
// match would discard any statement containing it — which is how tranche 3
// measured an advisory lock at ZERO statements. The pattern below matches the
// WHOLE statement, and the case at the end asserts that not one measured
// statement of this store would have been swallowed by it.

import { afterAll, beforeAll, expect, test } from "vitest";

import type {
  ErasureOperationId,
  ErasureTombstoneId,
  IdempotencyKey,
  SubjectKeyHash,
  TombstoneDraft,
} from "@platos/context-privacy/application/ports/index.js";

import type { PrivacyHarness, PrivacyTenant } from "./privacy-harness.js";
import { operationDraft, outcomeDraft, REQUESTED_AT, startPrivacyHarness } from "./privacy-harness.js";

let harness: PrivacyHarness;
/** One operation, three aliases. */
let small: PrivacyTenant;
/** Twenty-two operations, thirty aliases. */
let large: PrivacyTenant;

let smallOperationId = "";
let largeOperationId = "";
let smallAliases: string[] = [];
let largeAliases: string[] = [];

const HEAVY = 30;
const OPERATIONS = 22;
const EXPIRES_AT = new Date("2026-06-01T09:00:00.000Z");
const SUBJECT = "d0000abc";

function id<Brand>(value: string): Brand {
  return value as Brand;
}

function queries(): readonly string[] {
  return harness
    .statements()
    .filter(
      (statement) =>
        !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)\s*$/iu.test(statement) &&
        !/^\s*SELECT 1\s*$/iu.test(statement),
    );
}

/** Let the client's `query` events arrive before they are counted. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

/** Run `work` and return how many statements of this store's it sent. */
async function measure(work: () => Promise<unknown>): Promise<number> {
  await settle();
  harness.resetStatements();
  await work();
  await settle();
  return queries().length;
}

function draftsFor(tenant: PrivacyTenant, aliases: readonly string[], operationId: string): TombstoneDraft[] {
  return aliases.map((aliasHash) => ({
    organizationId: tenant.organizationId,
    aliasHash: id(aliasHash),
    operationId: id<ErasureOperationId>(operationId),
    policyVersion: "privacy/1",
    sealedAt: REQUESTED_AT,
    expiresAt: EXPIRES_AT,
  }));
}

beforeAll(async () => {
  harness = await startPrivacyHarness();
  small = await harness.freshTenant();
  large = await harness.freshTenant();

  smallOperationId = harness.base.freshId("00b0");
  await harness.run((transaction) =>
    harness.repository.insertOperation(
      operationDraft(small, smallOperationId, { nextRetryAt: REQUESTED_AT }),
      transaction,
    ),
  );
  smallAliases = ["a-s-1", "a-s-2", "a-s-3"].map((alias) => `${alias}-${smallOperationId.slice(-8)}`);
  await harness.run((transaction) =>
    harness.repository.sealTombstones(
      draftsFor(small, smallAliases, smallOperationId),
      smallAliases.map(() => id<ErasureTombstoneId>(harness.base.freshId("00b1"))),
      transaction,
    ),
  );

  largeOperationId = harness.base.freshId("00b2");
  for (let index = 0; index < OPERATIONS; index += 1) {
    const operationId = index === 0 ? largeOperationId : harness.base.freshId("00b3");
    await harness.run((transaction) =>
      harness.repository.insertOperation(
        operationDraft(large, operationId, {
          idempotencyKey: id<IdempotencyKey>(`key-${operationId}`),
          subjectKeyHash: id<SubjectKeyHash>(SUBJECT),
          // Distinct instants, so `listDueOperations`' ORDER BY has no tie to
          // resolve and the page it returns is the page it promises.
          requestedAt: new Date(REQUESTED_AT.getTime() + index),
          nextRetryAt: new Date(REQUESTED_AT.getTime() + index),
        }),
        transaction,
      ),
    );
  }
  largeAliases = Array.from(
    { length: HEAVY },
    (_unused, index) => `a-l-${String(index)}-${largeOperationId.slice(-8)}`,
  );
  await harness.run((transaction) =>
    harness.repository.sealTombstones(
      draftsFor(large, largeAliases, largeOperationId),
      largeAliases.map(() => id<ErasureTombstoneId>(harness.base.freshId("00b4"))),
      transaction,
    ),
  );
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

test("the barrier check is ONE statement, for three aliases and for thirty", async () => {
  // THE HOT PATH. `guard-subject-write.ts` calls this before any identity is
  // resolved or minted, on every request in the system, and the alias set is one
  // entry per identity channel the person can be reached on. One `IN` and not one
  // query per alias.
  const three = await measure(() =>
    harness.repository.findActiveTombstones(
      small.organizationId,
      smallAliases.map((alias) => id(alias)),
      REQUESTED_AT,
    ),
  );
  const thirty = await measure(() =>
    harness.repository.findActiveTombstones(
      large.organizationId,
      largeAliases.map((alias) => id(alias)),
      REQUESTED_AT,
    ),
  );
  expect(three).toBe(1);
  expect(thirty).toBe(three);
});

test("an EMPTY alias set costs ZERO statements", async () => {
  // Not an optimisation: `guard-subject-write.ts` returns early on an empty set,
  // so every OTHER caller on the hot path — the outbox drain's batch form — would
  // otherwise send `aliasHash IN ()` on every anonymous request in the system.
  expect(
    await measure(() =>
      harness.repository.findActiveTombstones(small.organizationId, [], REQUESTED_AT),
    ),
  ).toBe(0);
});

test("a seal is THREE statements, for three aliases and for thirty", async () => {
  // A scoped read to split the set, one `createMany` and one `updateMany`. Never
  // one round trip per alias — see the header. The re-seal below is measured
  // rather than the first seal, because a first seal has nothing to extend and
  // would hide the third statement.
  const three = await measure(() =>
    harness.run((transaction) =>
      harness.repository.sealTombstones(
        draftsFor(small, [...smallAliases, `a-s-new-${smallOperationId.slice(-8)}`], smallOperationId),
        [...smallAliases, "x"].map(() => id<ErasureTombstoneId>(harness.base.freshId("00b5"))),
        transaction,
      ),
    ),
  );
  const thirty = await measure(() =>
    harness.run((transaction) =>
      harness.repository.sealTombstones(
        draftsFor(large, [...largeAliases, `a-l-new-${largeOperationId.slice(-8)}`], largeOperationId),
        [...largeAliases, "x"].map(() => id<ErasureTombstoneId>(harness.base.freshId("00b6"))),
        transaction,
      ),
    ),
  );
  expect(three).toBe(3);
  expect(thirty).toBe(three);
});

test("a seal with NOTHING to extend is TWO statements, and one with nothing to insert is TWO", async () => {
  // The two halves of the split, each measured on its own, so the three above is
  // read as "read + insert + extend" rather than as a coincidence. A store that
  // sent an empty `createMany` or an empty `updateMany` would measure three here
  // as well and would be doing work on rows it had already decided were not
  // there.
  const fresh = `a-s-only-${harness.base.freshId("00b7").slice(-8)}`;
  const insertOnly = await measure(() =>
    harness.run((transaction) =>
      harness.repository.sealTombstones(
        draftsFor(small, [fresh], smallOperationId),
        [id<ErasureTombstoneId>(harness.base.freshId("00b8"))],
        transaction,
      ),
    ),
  );
  const extendOnly = await measure(() =>
    harness.run((transaction) =>
      harness.repository.sealTombstones(
        draftsFor(small, [fresh], smallOperationId),
        [id<ErasureTombstoneId>(harness.base.freshId("00b9"))],
        transaction,
      ),
    ),
  );
  expect(insertOnly).toBe(2);
  expect(extendOnly).toBe(2);
});

test("the queue's page is ONE statement, whatever the page holds", async () => {
  const one = await measure(() => harness.repository.listDueOperations(EXPIRES_AT, 1));
  const many = await measure(() => harness.repository.listDueOperations(EXPIRES_AT, 100));
  expect(one).toBe(1);
  expect(many).toBe(one);
  // And the page really did hold more than one row, or the pin above is measuring
  // an empty result set.
  const page = await harness.repository.listDueOperations(EXPIRES_AT, 100);
  expect(page.ok && page.value.length).toBeGreaterThan(OPERATIONS);
});

test("a subject's whole history is ONE statement, for one operation and for twenty-two", async () => {
  // The receipt list an operator reads. One digest, every operation ever recorded
  // for it, newest first — and a store that paged it per row would be sending one
  // query per erasure the person ever asked for.
  const one = await measure(() =>
    harness.repository.listOperationsForSubject(small.organizationId, id(SUBJECT)),
  );
  const twentyTwo = await measure(() =>
    harness.repository.listOperationsForSubject(large.organizationId, id(SUBJECT)),
  );
  expect(one).toBe(1);
  expect(twentyTwo).toBe(one);
  const rows = await harness.repository.listOperationsForSubject(large.organizationId, id(SUBJECT));
  expect(rows.ok && rows.value).toHaveLength(OPERATIONS);
  // Newest first, which is what the port promises and what an ORDER BY on a
  // column with distinct values can actually deliver.
  const requested = rows.ok ? rows.value.map((row) => row.requestedAt.getTime()) : [];
  expect([...requested].sort((left, right) => right - left)).toEqual(requested);
});

test("every point method is ONE statement, and the lease's LOSING path is two", async () => {
  expect(
    await measure(() =>
      harness.repository.findOperation(small.organizationId, id<ErasureOperationId>(smallOperationId)),
    ),
  ).toBe(1);
  expect(
    await measure(() =>
      harness.repository.findByIdempotencyKey(
        small.organizationId,
        id<IdempotencyKey>(`key-${smallOperationId}`),
      ),
    ),
  ).toBe(1);
  expect(
    await measure(() =>
      harness.run((transaction) =>
        harness.repository.insertOperation(
          operationDraft(small, harness.base.freshId("00ba")),
          transaction,
        ),
      ),
    ),
  ).toBe(1);
  expect(
    await measure(() =>
      harness.run((transaction) =>
        harness.repository.updateProgress(
          small.organizationId,
          id<ErasureOperationId>(smallOperationId),
          {
            workStatus: "ACTIVE",
            outcomes: [outcomeDraft("memory")],
            legalHoldPolicyId: null,
            retryCount: 1,
            startedAt: REQUESTED_AT,
            completedAt: null,
            nextRetryAt: REQUESTED_AT,
            leaseToken: null,
            leaseExpiresAt: null,
          },
          transaction,
        ),
      ),
    ),
  ).toBe(1);

  // THE COMPARE-AND-SET IS ONE STATEMENT ON THE WINNING PATH, which is what the
  // port requires: "the check and the claim must be one operation or two resumes
  // racing both see a free lease".
  const won = await measure(() =>
    harness.run((transaction) =>
      harness.repository.claimLease(
        small.organizationId,
        id<ErasureOperationId>(smallOperationId),
        { token: id("lease-a"), expiresAt: EXPIRES_AT },
        REQUESTED_AT,
        transaction,
      ),
    ),
  );
  expect(won).toBe(1);
  // And TWO on the losing path, because zero affected rows is two different
  // facts — held, or not here — and the port answers them differently. Only the
  // loser pays for the second statement.
  const lost = await measure(() =>
    harness.run((transaction) =>
      harness.repository.claimLease(
        small.organizationId,
        id<ErasureOperationId>(smallOperationId),
        { token: id("lease-b"), expiresAt: EXPIRES_AT },
        REQUESTED_AT,
        transaction,
      ),
    ),
  );
  expect(lost).toBe(2);
});

test("the retention sweep is ONE statement, whatever it deletes", async () => {
  const nothing = await measure(() =>
    harness.run((transaction) => harness.repository.purgeExpiredTombstones(REQUESTED_AT, transaction)),
  );
  const everything = await measure(() =>
    harness.run((transaction) =>
      harness.repository.purgeExpiredTombstones(new Date("2027-01-01T00:00:00.000Z"), transaction),
    ),
  );
  expect(nothing).toBe(1);
  expect(everything).toBe(nothing);
});

test("the probe filter would not have swallowed a single statement this store sent", async () => {
  // The anchor, asserted. Tranche 3 measured an advisory lock at ZERO statements
  // because its filter discarded anything CONTAINING `SELECT 1`, and the lock
  // projected exactly that. Every statement below is recorded RAW and then
  // checked against the same anchored patterns the filter uses.
  await settle();
  harness.resetStatements();
  await harness.run((transaction) =>
    harness.repository.insertOperation(operationDraft(small, harness.base.freshId("00bb")), transaction),
  );
  await harness.repository.findActiveTombstones(
    small.organizationId,
    smallAliases.map((alias) => id(alias)),
    REQUESTED_AT,
  );
  await settle();
  const raw = harness.statements();
  const discarded = raw.filter((statement) => /^\s*SELECT 1\s*$/iu.test(statement));
  const substringWouldDiscard = raw.filter((statement) => statement.includes("SELECT 1"));
  expect(queries().length).toBeGreaterThan(0);
  // The anchored filter discards only the driver's own probe...
  expect(discarded.every((statement) => statement.trim() === "SELECT 1")).toBe(true);
  // ...and a SUBSTRING filter would have discarded exactly the same set, which is
  // what makes this store's measurements trustworthy rather than lucky.
  expect(substringWouldDiscard.length).toBe(discarded.length);
});
