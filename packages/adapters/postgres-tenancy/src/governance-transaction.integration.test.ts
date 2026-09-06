// The transaction boundary, proved by FAILURE INJECTION against a real database,
// and the three scope refusals.
//
// WHY INJECTION AND NOT A ROLLBACK COUNT. A store that counted rollbacks would
// pass a suite that asserted rollbacks. Every case below forces the SECOND write
// of a two-store operation to fail and then LOOKS FOR THE FIRST ROW — over a
// second client, on a connection this adapter's pool never touched, because
// durability is not "the row is there when the writer looks again" but "the row
// is there when somebody else looks".
//
// THE OPERATION IS THIS CONTEXT'S OWN. `governance-erasure-target.ts` counts a
// subject's safety events and ratings and then ANONYMISES the first and DESTROYS
// the second, and both port signatures put the mutation in the caller's
// `TransactionScope`. That is the pair measured here.
//
// *** AND THE SUITE REPORTS A TRAP RATHER THAN HIDING IT. *** There are TWO ways
// the second write can fail, and they do NOT behave the same:
//
//   A DATABASE refusal aborts the transaction. PostgreSQL puts the block in
//   25P02, the driver's COMMIT becomes a ROLLBACK, and the first write is gone
//   whether or not the callback resolved.
//
//   A GUARD refusal sends no statement at all — which is the whole point of
//   `governance-guards.ts` — so the transaction is untouched. A callback that
//   RETURNS that error `Result` therefore RESOLVES, and a resolved callback
//   COMMITS. The first write survives.
//
// The second is the `cost-monitoring` trap in this context's own shape, it is
// not preventable by the store, and it is measured here so nobody has to
// discover it in production: a use case composing two of these writes must
// THROW on a refusal, not return it. Both halves are pinned.

import { afterAll, beforeAll, expect, test } from "vitest";

import type {
  AgentId,
  AgentVersionId,
  EndUserId,
  EnvironmentScope,
  TurnId,
} from "@platos/context-governance/application/ports/index.js";
import { asGovernanceIdentifier } from "@platos/context-governance/application/ports/index.js";
import type { TransactionId } from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier } from "@platos/context-tenancy/application/ports/index.js";
import { runResult } from "@platos/context-governance/application/ports/index.js";

import type { TenancyDatabaseClient } from "./client.js";
import {
  conformanceSafetyEvent,
  type GovernanceConformanceIds,
} from "./governance-conformance.js";
import type { GovernanceHarness, PeerChain } from "./governance-harness.js";
import { startGovernanceHarness } from "./governance-harness.js";
import {
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
} from "./transaction.js";

let harness: GovernanceHarness;
let chain: PeerChain;
let scope: EnvironmentScope;
let ids: GovernanceConformanceIds;
/** A SECOND client over the same database. Nothing this adapter's pool touched. */
let observer: TenancyDatabaseClient;

beforeAll(async () => {
  harness = await startGovernanceHarness();
  scope = await harness.freshScope();
  chain = await harness.seedChain(scope);
  ids = {
    agentId: chain.agentId,
    agentVersionId: chain.agentVersionId,
    secondAgentVersionId: chain.secondAgentVersionId,
    endUserId: chain.endUserId,
    threadId: chain.threadId,
    turnId: chain.turnId,
    secondTurnId: chain.secondTurnId,
    absentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };
  const { PrismaClient } = await import("@platos/tenancy-database");
  observer = new PrismaClient({
    datasources: { db: { url: harness.base.databaseUrl } },
  }) as TenancyDatabaseClient;
}, 300_000);

afterAll(async () => {
  await observer?.$disconnect();
  await harness?.stop();
});

function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return `<uncoded:${String(error)}>`;
}

/** One rating for the seeded turn, so the erasure pair has something to erase. */
async function seedRating(turnId: string): Promise<void> {
  const written = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
    harness.stores.ratings.upsert(
      scope,
      {
        turnId: asGovernanceIdentifier<TurnId>(turnId),
        agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
        agentVersionId: asGovernanceIdentifier<AgentVersionId>(ids.agentVersionId),
        endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
        rating: 1,
        comment: null,
        revision: 1,
      },
      transaction,
    ),
  );
  if (!written.ok) throw new Error("the fixture rating was refused");
}

test("a DATABASE refusal on the second write takes the first with it", async () => {
  const subject = `subject-${harness.base.freshId("0020")}`;
  const written = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
    harness.stores.safety.append(
      scope,
      conformanceSafetyEvent(ids, { principalId: subject }),
      transaction,
    ),
  );
  expect(written.ok).toBe(true);
  if (!written.ok) return;

  const foreign = await harness.foreignChain();
  await harness.base.adapter.unitOfWork.run(async (transaction) => {
    // FIRST: a real anonymisation, which really writes.
    const erased = await harness.stores.safety.anonymizeSubject({ scope, principalId: subject }, transaction);
    expect(erased.ok && erased.value).toBe(1);
    // SECOND: a rating whose version belongs to another agent —
    // `MessageRating_ancestry` refuses it, and PostgreSQL aborts the block.
    const refused = await harness.stores.ratings.upsert(
      scope,
      {
        turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
        agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
        agentVersionId: asGovernanceIdentifier<AgentVersionId>(foreign.agentVersionId),
        endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
        rating: 1,
        comment: null,
        revision: 1,
      },
      transaction,
    );
    expect(refused.ok).toBe(false);
    // The callback RESOLVES. Nothing here throws.
  });

  // OVER THE SECOND CLIENT. The anonymisation did not survive: the row still
  // carries its detail, because the block it ran in was rolled back.
  const row = await observer.safetyEvent.findUnique({
    where: { id: written.value.safetyEventId },
    select: { detail: true, metadata: true },
  });
  expect(row?.detail).toBe("an email address was seen");
  expect(row?.metadata).not.toBeNull();
});

test("a GUARD refusal does NOT, and a caller that RETURNS it commits the first write", async () => {
  // *** THE TRAP, MEASURED. *** The guard sends no statement, so PostgreSQL never
  // learns anything went wrong; the callback resolves and Prisma commits. This
  // is `cost-monitoring`'s shipped defect in this context's shape, and it is not
  // something a store can fix: the port returns a `Result` and a `Result` is not
  // an exception. It is pinned so a use case author knows the rule.
  const subject = `subject-${harness.base.freshId("0021")}`;
  const written = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
    harness.stores.safety.append(
      scope,
      conformanceSafetyEvent(ids, { principalId: subject }),
      transaction,
    ),
  );
  expect(written.ok).toBe(true);
  if (!written.ok) return;

  await harness.base.adapter.unitOfWork.run(async (transaction) => {
    const erased = await harness.stores.safety.anonymizeSubject({ scope, principalId: subject }, transaction);
    expect(erased.ok && erased.value).toBe(1);
    // A five-star `3`: refused by `governance-guards.ts` BEFORE any statement,
    // because the constraint the migration ENDS with is `IN (-1, 1)`.
    const refused = await harness.stores.ratings.upsert(
      scope,
      {
        turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
        agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
        agentVersionId: null,
        endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
        rating: 3 as unknown as 1,
        comment: null,
        revision: 1,
      },
      transaction,
    );
    expect(refused.ok).toBe(false);
  });

  const committed = await observer.safetyEvent.findUnique({
    where: { id: written.value.safetyEventId },
    select: { detail: true, metadata: true },
  });
  // COMMITTED. The anonymisation stands even though the operation it was half of
  // did not complete.
  expect(committed?.detail).toBeNull();
  expect(committed?.metadata).toBeNull();
});

test("and THROWING the same refusal rolls both halves back", async () => {
  // The other half of the pair above, and the rule a use case has to follow.
  const subject = `subject-${harness.base.freshId("0022")}`;
  const written = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
    harness.stores.safety.append(
      scope,
      conformanceSafetyEvent(ids, { principalId: subject }),
      transaction,
    ),
  );
  expect(written.ok).toBe(true);
  if (!written.ok) return;

  await expect(
    harness.base.adapter.unitOfWork.run(async (transaction) => {
      const erased = await harness.stores.safety.anonymizeSubject(
        { scope, principalId: subject },
        transaction,
      );
      expect(erased.ok && erased.value).toBe(1);
      const refused = await harness.stores.ratings.upsert(
        scope,
        {
          turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
          agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
          agentVersionId: null,
          endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
          rating: 3 as unknown as 1,
          comment: null,
          revision: 1,
        },
        transaction,
      );
      if (!refused.ok) throw new Error("erasure abandoned");
    }),
  ).rejects.toThrow("erasure abandoned");

  const rolled = await observer.safetyEvent.findUnique({
    where: { id: written.value.safetyEventId },
    select: { detail: true },
  });
  expect(rolled?.detail).toBe("an email address was seen");
});

test("the erasure pair COMMITS together when nothing fails", async () => {
  // The negative control. Without it every case above would pass against a store
  // that never wrote anything at all.
  const subject = `subject-${harness.base.freshId("0023")}`;
  await seedRating(ids.secondTurnId);
  const written = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
    harness.stores.safety.append(
      scope,
      conformanceSafetyEvent(ids, { principalId: subject }),
      transaction,
    ),
  );
  expect(written.ok).toBe(true);
  if (!written.ok) return;

  await harness.base.adapter.unitOfWork.run(async (transaction) => {
    await harness.stores.safety.anonymizeSubject({ scope, principalId: subject }, transaction);
    await harness.stores.ratings.eraseSubject(
      { scope, endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId) },
      transaction,
    );
  });

  const anonymised = await observer.safetyEvent.findUnique({
    where: { id: written.value.safetyEventId },
    select: { detail: true, detector: true },
  });
  expect(anonymised?.detail).toBeNull();
  // The compliance fact survives the erasure of the subject.
  expect(anonymised?.detector).toBe("pii");
  expect(
    await observer.messageRating.count({ where: { endUserId: ids.endUserId } }),
  ).toBe(0);
});

test("an append with a NULL transaction JOINS the open one rather than escaping to the pool", async () => {
  // `SafetyLedger.append` takes `TransactionScope | null` because the kernel
  // `SafetyEventSink` records outside any unit of work. Resolving that null
  // through the POOL would have made the row uncancellable by the caller's own
  // rollback — a safety event written by a turn that was itself rolled back.
  let appendedId: string | null = null;
  await expect(
    harness.base.adapter.unitOfWork.run(async () => {
      const written = await harness.stores.safety.append(
        scope,
        conformanceSafetyEvent(ids, { principalId: "subject-ambient" }),
        null,
      );
      expect(written.ok).toBe(true);
      if (written.ok) appendedId = written.value.safetyEventId;
      throw new Error("the turn was abandoned");
    }),
  ).rejects.toThrow("the turn was abandoned");

  expect(appendedId).not.toBeNull();
  expect(await observer.safetyEvent.count({ where: { id: appendedId ?? "" } })).toBe(0);
});

test("an APPEND carrying a scope is held to the same three refusals", async () => {
  // The case above measures the refusals through `criteria.remove`. This one
  // measures them through `safety.append`, which is the ONE method in this
  // context whose transaction parameter is NULLABLE — so it is the one method an
  // implementation could plausibly have resolved through `reader()` on both
  // branches, which would silently accept a finished or a foreign token.
  const stale = await harness.base.adapter.unitOfWork.run(async (transaction) => transaction);
  await expect(
    runResult(harness.base.adapter.unitOfWork, () =>
      harness.stores.safety.append(scope, conformanceSafetyEvent(ids), stale),
    ),
  ).rejects.toThrow();
  const refusal = await runResult(
    harness.base.adapter.unitOfWork, () => harness.stores.safety.append(scope, conformanceSafetyEvent(ids), stale))
    .then(() => "<no refusal>", (error: unknown) => codeOf(error));
  // The token names a transaction that has already committed, so it is UNKNOWN
  // rather than foreign and rather than absent.
  expect(refusal).toBe(TRANSACTION_SCOPE_UNKNOWN);
});

test("the three scope refusals are three DISTINCT codes", async () => {
  const write = (transaction: { readonly transactionId: TransactionId }) =>
    harness.stores.criteria.remove(scope, asGovernanceIdentifier(ids.absentId), transaction);

  // NOT OPEN: a write with a token and no transaction around it.
  await expect(write({ transactionId: asIdentifier<TransactionId>("pg-txn-1") })).rejects.toThrow();
  const notOpen = await write({ transactionId: asIdentifier<TransactionId>("pg-txn-1") }).then(
    () => "<no refusal>",
    (error: unknown) => codeOf(error),
  );

  // UNKNOWN: inside a real transaction, carrying a token that names none.
  const unknown = await harness.base.adapter.unitOfWork.run(async () =>
    write({ transactionId: asIdentifier<TransactionId>("pg-txn-does-not-exist") }).then(
      () => "<no refusal>",
      (error: unknown) => codeOf(error),
    ),
  );

  // FOREIGN: a SECOND transaction held open CONCURRENTLY, whose token is live
  // and is not this block's. Nesting `run` inside `run` would not produce it —
  // the kernel port says nesting JOINS — so the other transaction is started
  // outside this async context and parked on a gate. The token is therefore in
  // `open` when the write is issued, so only the identity check can refuse it,
  // which is exactly what separates `scope_foreign` from `scope_unknown`.
  let release = (): void => undefined;
  const gate = new Promise<void>((settle) => {
    release = settle;
  });
  let concurrent: { readonly transactionId: TransactionId } | undefined;
  const held = new Promise<void>((ready) => {
    void harness.base.adapter.unitOfWork.run(async (transaction) => {
      concurrent = transaction;
      ready();
      await gate;
    });
  });
  await held;
  const other = concurrent as { readonly transactionId: TransactionId };

  let foreign: string = "<no refusal>";
  await harness.base.adapter.unitOfWork.run(async (live) => {
    expect(other.transactionId).not.toBe(live.transactionId);
    foreign = await write(other).then(
      () => "<no refusal>",
      (error: unknown) => codeOf(error),
    );
  });
  release();

  expect(notOpen).toBe(TRANSACTION_NOT_OPEN);
  expect(unknown).toBe(TRANSACTION_SCOPE_UNKNOWN);
  expect(foreign).toBe(TRANSACTION_SCOPE_FOREIGN);
  // Three codes, three mistakes. A single shared code is how two defects hid
  // behind one in `privacy` and in `identity-access`.
  expect(new Set([notOpen, unknown, foreign]).size).toBe(3);
});
