// The database rules NO port method restates, and the two places the port's
// contract and the schema cannot both be honoured.
//
// A CASCADE, AN ANCESTRY RULE THAT RUNS ON UPDATE, AN INDEX THE DOUBLE DOES
// NOT HOLD, and
// two rows written the way an OLDER binary would have written them. None of
// these is reachable by reading `schema.prisma` and none is enforced by any code
// in this package; they are properties of the deployed database, so they are
// measured against one.
//
// EVERY OBSERVATION THAT MATTERS IS TAKEN OVER A SECOND CLIENT, on a connection
// this adapter's pool never touched. A cascade that only the writer can see is
// not a cascade.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  ActorId,
  AgentId,
  AgentVersionId,
  EndUserId,
  EnvironmentScope,
  EvalCriterionId,
  TransactionScope,
  TurnId,
} from "@platos/context-governance/application/ports/index.js";
import { asGovernanceIdentifier } from "@platos/context-governance/application/ports/index.js";
import { InMemoryGoldenSetsRepository } from "@platos/context-governance/application/testing/index.js";

import type { TenancyDatabaseClient } from "./client.js";
import {
  conformanceCriterion,
  conformanceEval,
  conformanceGoldenSet,
  conformanceSafetyEvent,
  governanceConformanceClock,
  type GovernanceConformanceIds,
} from "./governance-conformance.js";
import type { GovernanceHarness, PeerChain } from "./governance-harness.js";
import { startGovernanceHarness } from "./governance-harness.js";
import { UNKNOWN_SAFETY_DETECTOR } from "./governance-rows.js";

let harness: GovernanceHarness;
let chain: PeerChain;
let scope: EnvironmentScope;
let ids: GovernanceConformanceIds;
/** A SECOND client over the same database. Nothing this adapter's pool touched. */
let observer: TenancyDatabaseClient;

const actor = asGovernanceIdentifier<ActorId>("operator-1");

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

function reasonOf(result: { readonly ok: boolean }): string {
  if (result.ok) return "<accepted>";
  const { error } = result as unknown as {
    readonly error: { readonly details: Record<string, unknown> };
  };
  return String(error.details["reason"] ?? "");
}

async function freshCriterion(name: string): Promise<EvalCriterionId> {
  const created = await harness.base.adapter.unitOfWork.run((transaction) =>
    harness.stores.criteria.create(scope, conformanceCriterion({ name }), actor, transaction),
  );
  if (!created.ok) throw new Error(`fixture criterion ${name} was refused`);
  return created.value.evalCriterionId;
}

test("deleting a criterion destroys every eval taken against it, and the database does it", async () => {
  const criterionId = await freshCriterion(`cascade-${Date.now()}`);
  const appended = await harness.base.adapter.unitOfWork.run((transaction) =>
    harness.stores.evals.append(scope, conformanceEval(ids, criterionId), transaction),
  );
  expect(appended.ok).toBe(true);
  if (!appended.ok) return;

  expect(await observer.agentEval.count({ where: { criterionId } })).toBe(1);

  await harness.base.adapter.unitOfWork.run((transaction) =>
    harness.stores.criteria.remove(scope, criterionId, transaction),
  );

  // OVER THE SECOND CLIENT. `AgentEval.criterion @relation(onDelete: Cascade)`
  // took the measurement with the question, and no statement in this package
  // deleted it — `governance-evals.ts` has no DELETE at all.
  expect(await observer.agentEval.count({ where: { criterionId } })).toBe(0);
  expect(await observer.agentEval.count({ where: { id: appended.value.agentEvalId } })).toBe(0);
});

test("`rawResponseTruncated` is echoed on write and FALSE on every read: no column carries it", async () => {
  // *** THE PORT CONTRACT THE DATABASE CANNOT HONOUR. *** `domain/agent-eval.ts`
  // puts the flag on the ROW so a reader can tell "the judge said this" from
  // "the judge said this and more". `AgentEval` has no column for it and no
  // metadata column to carry one in. The honest repair is a column in an ordered
  // migration; until then this is what the store does and this case is what says
  // so out loud.
  const criterionId = await freshCriterion(`truncated-${Date.now()}`);
  const appended = await harness.base.adapter.unitOfWork.run((transaction) =>
    harness.stores.evals.append(
      scope,
      conformanceEval(ids, criterionId, { rawResponseTruncated: true, rawResponse: "cut" }),
      transaction,
    ),
  );
  expect(appended.ok).toBe(true);
  if (!appended.ok) return;
  // The writer's own knowledge, echoed rather than invented.
  expect(appended.value.rawResponseTruncated).toBe(true);

  const read = await harness.stores.evals.findById(scope, appended.value.agentEvalId);
  expect(read.ok && read.value?.rawResponse).toBe("cut");
  // And the row does not remember.
  expect(read.ok && read.value?.rawResponseTruncated).toBe(false);
});

describe("the safety metadata envelope, against rows an older binary wrote", () => {
  test("a bare attribute bag is read as attributes, with no subject and no rule", async () => {
    // Written the way the legacy source wrote it: the producer's object, at the
    // root, with no marker. Expand/contract requires this to READ, and it is the
    // reason `readSafetyEnvelope` discriminates rather than assuming.
    const legacyId = harness.base.freshId("001c");
    harness.applyPeerRows(
      `INSERT INTO "SafetyEvent" ("id", "environmentId", "detector", "action", "severity", "metadata", "createdAt")
       VALUES ('${legacyId}', '${scope.environmentId}', 'pii', 'flag', 'high',
               '{"principalId":"looks-like-a-subject","hits":3}'::jsonb, '2026-05-01T09:00:00Z');`,
    );
    const read = await harness.stores.safety.findById(scope, asGovernanceIdentifier(legacyId));
    expect(read.ok).toBe(true);
    if (!read.ok || read.value === null) throw new Error("the legacy row was not read");
    expect(read.value.metadata).toEqual({ principalId: "looks-like-a-subject", hits: 3 });
    // NOT the ledger's subject. A detector attribute that happens to be called
    // `principalId` must not be erasable on somebody else's behalf.
    expect(read.value.principalId).toBeNull();
    expect(read.value.rule).toBeNull();
    expect(read.value.detailTruncated).toBe(false);

    const counted = await harness.stores.safety.countSubject({
      scope,
      principalId: "looks-like-a-subject",
    });
    expect(counted.ok && counted.value).toBe(0);
  });

  test("a detector this binary does not know is REFUSED on read, not cast", async () => {
    // `detector` is a plain `String` column: the closed set lives in the domain
    // and nowhere in the database. A cast would put a value outside
    // `SafetyDetector` into `summarise`, whose histograms are keyed by the union,
    // and the total would stop equalling the sum of the parts.
    const oddId = harness.base.freshId("001d");
    harness.applyPeerRows(
      `INSERT INTO "SafetyEvent" ("id", "environmentId", "detector", "action", "severity", "createdAt")
       VALUES ('${oddId}', '${scope.environmentId}', 'PII', 'flag', 'high', '2026-05-01T09:00:00Z');`,
    );
    const read = await harness.stores.safety.findById(scope, asGovernanceIdentifier(oddId));
    expect(read.ok).toBe(false);
    expect(reasonOf(read)).toContain(UNKNOWN_SAFETY_DETECTOR);
  });
});

test("anonymising OVERWRITES and never deletes, seen from a connection that did not write it", async () => {
  const written = await harness.base.adapter.unitOfWork.run((transaction) =>
    harness.stores.safety.append(
      scope,
      conformanceSafetyEvent(ids, {
        principalId: "subject-erased",
        detail: "an email address was seen",
        metadata: { hits: 1 },
      }),
      transaction,
    ),
  );
  expect(written.ok).toBe(true);
  if (!written.ok) return;

  const erased = await harness.base.adapter.unitOfWork.run((transaction) =>
    harness.stores.safety.anonymizeSubject({ scope, principalId: "subject-erased" }, transaction),
  );
  expect(erased.ok && erased.value).toBe(1);

  const row = await observer.safetyEvent.findUnique({
    where: { id: written.value.safetyEventId },
    select: { detector: true, action: true, severity: true, detail: true, metadata: true, endUserId: true },
  });
  // THE ROW IS STILL THERE. A compliance ledger that can be emptied is not a
  // compliance ledger, and this is that sentence measured.
  expect(row).not.toBeNull();
  expect(row?.detector).toBe("pii");
  expect(row?.severity).toBe("high");
  // And the identifying columns are gone. `metadata` is SQL NULL rather than the
  // JSON scalar `null`, which `SafetyEvent_metadata_json_root` would refuse.
  expect(row?.detail).toBeNull();
  expect(row?.metadata).toBeNull();
  expect(row?.endUserId).toBeNull();
});

test("a golden-set RENAME onto a taken name: the double allows it, the index does not", async () => {
  // *** A GAP IN THE CONTEXT'S OWN DOUBLE. *** `InMemoryGoldenSetsRepository.update`
  // locates the row by id and replaces it, with no uniqueness check at all — so
  // it will happily leave two rows `@@unique([environmentId, agentId, name])`
  // forbids. This is why the rename is NOT in the shared conformance scenario:
  // there the double's answer would be wrong rather than merely different.
  const agentId = asGovernanceIdentifier<AgentId>(ids.agentId);
  const fake = new InMemoryGoldenSetsRepository(governanceConformanceClock());
  const transaction: TransactionScope = { transactionId: asGovernanceIdentifier("txn-1") };
  const first = await fake.create(scope, conformanceGoldenSet(ids, { name: "alpha" }), actor, transaction);
  const second = await fake.create(scope, conformanceGoldenSet(ids, { name: "beta" }), actor, transaction);
  expect(first.ok && second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  const collided = await fake.update(scope, { ...second.value, name: "alpha" }, transaction);
  expect(collided.ok).toBe(true);
  const fakePage = await fake.page(scope, { limit: 10, offset: 0, agentId: null });
  expect(fakePage.ok && fakePage.value.items.filter((row) => row.name === "alpha").length).toBe(2);

  // THE REAL STORE. Two sets, then the same rename.
  const realFirst = await harness.base.adapter.unitOfWork.run((t) =>
    harness.stores.goldenSets.create(scope, conformanceGoldenSet(ids, { name: "alpha" }), actor, t),
  );
  const realSecond = await harness.base.adapter.unitOfWork.run((t) =>
    harness.stores.goldenSets.create(scope, conformanceGoldenSet(ids, { name: "beta" }), actor, t),
  );
  expect(realFirst.ok && realSecond.ok).toBe(true);
  if (!realSecond.ok) return;
  const refused = await harness.base.adapter.unitOfWork.run((t) =>
    harness.stores.goldenSets.update(scope, { ...realSecond.value, name: "alpha" }, t),
  );
  expect(refused.ok).toBe(false);
  expect(refused.ok ? "" : refused.error.code).toBe("GOVERNANCE_GOLDEN_SET_ALREADY_EXISTS");
  // And the pre-check kept the transaction: the row is untouched, not half-written.
  expect(
    await observer.goldenSet.count({ where: { environmentId: scope.environmentId, agentId, name: "alpha" } }),
  ).toBe(1);
});

test("`MessageRating_ancestry` fires on UPDATE, so a flip onto a foreign version is refused", async () => {
  // The rule runs `BEFORE INSERT OR UPDATE`. A flip that re-points
  // `agentVersionId` at a version belonging to ANOTHER agent passes every guard
  // in this package — it is a uuid, the rating is 1, the revision is positive —
  // and is refused by the database. That is the shape of rule an adapter cannot
  // pre-check without duplicating the rule's own joins.
  const foreign = await harness.foreignChain();
  const turnId = asGovernanceIdentifier<TurnId>(ids.secondTurnId);
  const endUserId = asGovernanceIdentifier<EndUserId>(ids.endUserId);

  const created = await harness.base.adapter.unitOfWork.run((transaction) =>
    harness.stores.ratings.upsert(
      scope,
      {
        turnId,
        agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
        agentVersionId: asGovernanceIdentifier<AgentVersionId>(ids.agentVersionId),
        endUserId,
        rating: 1,
        comment: null,
        revision: 1,
      },
      transaction,
    ),
  );
  expect(created.ok).toBe(true);

  const refused = await harness.base.adapter.unitOfWork.run((transaction) =>
    harness.stores.ratings.upsert(
      scope,
      {
        turnId,
        agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
        agentVersionId: asGovernanceIdentifier<AgentVersionId>(foreign.agentVersionId),
        endUserId,
        rating: 1,
        comment: null,
        revision: 2,
      },
      transaction,
    ),
  );
  expect(refused.ok).toBe(false);
  expect(reasonOf(refused)).toContain("ratings upsert");

  // The rollback took the whole unit of work, so the first revision stands.
  const row = await observer.messageRating.findFirst({ where: { turnId, endUserId } });
  expect(row?.revision).toBe(1);
});

test("a duplicate criterion name is a CODE and leaves the transaction writable", async () => {
  // `ON CONFLICT DO NOTHING` rather than a raised unique index, which is what
  // lets the caller carry on. Without it the second `create` would abort the
  // transaction and the third statement below would fail with 25P02.
  const name = `duplicate-${Date.now()}`;
  const outcome = await harness.base.adapter.unitOfWork.run(async (transaction) => {
    const first = await harness.stores.criteria.create(
      scope,
      conformanceCriterion({ name }),
      actor,
      transaction,
    );
    const second = await harness.stores.criteria.create(
      scope,
      conformanceCriterion({ name }),
      actor,
      transaction,
    );
    const third = await harness.stores.criteria.create(
      scope,
      conformanceCriterion({ name: `${name}-other` }),
      actor,
      transaction,
    );
    return { first: first.ok, second: second.ok ? null : second.error.code, third: third.ok };
  });
  expect(outcome).toEqual({
    first: true,
    second: "GOVERNANCE_CRITERION_ALREADY_EXISTS",
    third: true,
  });
});

test("an erasure destroys ONE subject's ratings and leaves every other subject's", async () => {
  // The count an erasure returns is right whether or not the subject predicate
  // is there, because the rows it destroyed are the rows it counted. The only
  // thing that sees a missing predicate is somebody ELSE'S vote, so this case
  // seeds one and looks for it afterwards.
  const chainA = await harness.foreignChain();
  const other = harness.base.freshId("001e");
  harness.applyPeerRows(
    `INSERT INTO "EndUser" ("id", "organizationId", "displayName", "createdAt", "updatedAt")
     VALUES ('${other}', '${chainA.scope.organizationId}', 'second rater', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');
     INSERT INTO "Thread" ("id", "environmentId", "agentId", "endUserId", "status", "createdAt", "updatedAt")
     VALUES ('${harness.base.freshId("001f")}', '${chainA.scope.environmentId}', '${chainA.agentId}', '${other}',
             'ACTIVE', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
  );
  // The second subject's vote has to hang off a turn in a thread THEY own —
  // `MessageRating_ancestry` demands exactly that — so it goes on a second
  // thread with a turn of its own.
  const otherThread = await observer.thread.findFirst({
    where: { endUserId: other },
    select: { id: true },
  });
  const otherTurn = harness.base.freshId("0020");
  harness.applyPeerRows(
    `INSERT INTO "Turn" ("id", "threadId", "agentVersionId", "versionBucket", "sequence", "status", "createdAt")
     VALUES ('${otherTurn}', '${otherThread?.id}', '${chainA.agentVersionId}', 'CURRENT', 1, 'SUCCEEDED',
             '2026-05-01T09:00:00Z');`,
  );

  for (const [turn, subject] of [
    [chainA.turnId, chainA.endUserId],
    [otherTurn, other],
  ] as const) {
    const written = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.ratings.upsert(
        chainA.scope,
        {
          turnId: asGovernanceIdentifier<TurnId>(turn),
          agentId: asGovernanceIdentifier<AgentId>(chainA.agentId),
          agentVersionId: asGovernanceIdentifier<AgentVersionId>(chainA.agentVersionId),
          endUserId: asGovernanceIdentifier<EndUserId>(subject),
          rating: 1,
          comment: null,
          revision: 1,
        },
        transaction,
      ),
    );
    expect(written.ok).toBe(true);
  }

  const erased = await harness.base.adapter.unitOfWork.run((transaction) =>
    harness.stores.ratings.eraseSubject(
      { scope: chainA.scope, endUserId: asGovernanceIdentifier<EndUserId>(chainA.endUserId) },
      transaction,
    ),
  );
  expect(erased.ok && erased.value).toBe(1);
  expect(
    await observer.messageRating.count({ where: { endUserId: chainA.endUserId } }),
  ).toBe(0);
  // THE ROW THAT MUST SURVIVE.
  expect(await observer.messageRating.count({ where: { endUserId: other } })).toBe(1);

  // And a NULL subject erases nothing at all, which the port requires and which
  // an implementation that dropped the predicate would get exactly backwards.
  const none = await harness.base.adapter.unitOfWork.run((transaction) =>
    harness.stores.ratings.eraseSubject({ scope: chainA.scope, endUserId: null }, transaction),
  );
  expect(none.ok && none.value).toBe(0);
  expect(await observer.messageRating.count({ where: { endUserId: other } })).toBe(1);
});

describe("every read and every write is narrowed to ONE environment", () => {
  // THE NEGATIVE CONTROL FOR `scopedWhere`. Each of the five tables is written
  // in a SECOND tenant and then asked for from the first, and every answer must
  // be the answer for an id that does not exist. A store whose narrowing was
  // dropped would still pass every other suite in this package, because every
  // other suite works inside one environment.
  test("a row in another environment is invisible, unwritable and undeletable", async () => {
    const foreign = await harness.foreignChain();
    const foreignIds = {
      ...ids,
      agentId: foreign.agentId,
      agentVersionId: foreign.agentVersionId,
      threadId: foreign.threadId,
      turnId: foreign.turnId,
    };

    const criterion = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.criteria.create(
        foreign.scope,
        conformanceCriterion({ name: `foreign-${Date.now()}` }),
        actor,
        transaction,
      ),
    );
    expect(criterion.ok).toBe(true);
    if (!criterion.ok) return;

    const set = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.goldenSets.create(
        foreign.scope,
        conformanceGoldenSet(foreignIds),
        actor,
        transaction,
      ),
    );
    expect(set.ok).toBe(true);
    if (!set.ok) return;

    const rating = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.ratings.upsert(
        foreign.scope,
        {
          turnId: asGovernanceIdentifier<TurnId>(foreign.turnId),
          agentId: asGovernanceIdentifier<AgentId>(foreign.agentId),
          agentVersionId: asGovernanceIdentifier<AgentVersionId>(foreign.agentVersionId),
          endUserId: asGovernanceIdentifier<EndUserId>(foreign.endUserId),
          rating: 1,
          comment: "from another tenant",
          revision: 1,
        },
        transaction,
      ),
    );
    expect(rating.ok).toBe(true);

    const event = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.safety.append(foreign.scope, conformanceSafetyEvent(foreignIds), transaction),
    );
    expect(event.ok).toBe(true);
    if (!event.ok) return;

    // READS from THIS scope, for rows that exist in the other one.
    const criterionFromHere = await harness.stores.criteria.findById(
      scope,
      criterion.value.evalCriterionId,
    );
    expect(criterionFromHere.ok && criterionFromHere.value).toBeNull();
    const byName = await harness.stores.criteria.findByName(scope, criterion.value.name);
    expect(byName.ok && byName.value).toBeNull();
    const setFromHere = await harness.stores.goldenSets.findById(scope, set.value.goldenSetId);
    expect(setFromHere.ok && setFromHere.value).toBeNull();
    const eventFromHere = await harness.stores.safety.findById(scope, event.value.safetyEventId);
    expect(eventFromHere.ok && eventFromHere.value).toBeNull();
    const ratingFromHere = await harness.stores.ratings.findForTurn(
      scope,
      asGovernanceIdentifier<TurnId>(foreign.turnId),
      asGovernanceIdentifier<EndUserId>(foreign.endUserId),
    );
    expect(ratingFromHere.ok && ratingFromHere.value).toBeNull();

    // WRITES from this scope must touch nothing over there.
    const flip = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.ratings.upsert(
        scope,
        {
          turnId: asGovernanceIdentifier<TurnId>(foreign.turnId),
          agentId: asGovernanceIdentifier<AgentId>(foreign.agentId),
          agentVersionId: null,
          endUserId: asGovernanceIdentifier<EndUserId>(foreign.endUserId),
          // A perfectly STORABLE value — `CHECK (rating IN (-1, 1))` admits it
          // — so nothing but the scope can be what refuses this write.
          rating: -1,
          comment: "reached across",
          revision: 9,
        },
        transaction,
      ),
    );
    // The scoped update matches nothing, so the create path runs and the
    // installation-wide unique index refuses it. Either way the other tenant's
    // row is untouched.
    expect(flip.ok).toBe(false);
    const untouched = await observer.messageRating.findFirst({
      where: { turnId: foreign.turnId, endUserId: foreign.endUserId },
      select: { comment: true, revision: true },
    });
    expect(untouched).toEqual({ comment: "from another tenant", revision: 1 });

    const removedCriterion = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.criteria.remove(scope, criterion.value.evalCriterionId, transaction),
    );
    expect(removedCriterion.ok && removedCriterion.value).toBe(false);
    const removedSet = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.goldenSets.remove(scope, set.value.goldenSetId, transaction),
    );
    expect(removedSet.ok && removedSet.value).toBe(false);
    const renamed = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.goldenSets.update(scope, { ...set.value, name: "renamed" }, transaction),
    );
    expect(renamed.ok).toBe(false);

    // And all four rows are still there, seen from a client that wrote none.
    expect(
      await observer.evalCriterion.count({ where: { id: criterion.value.evalCriterionId } }),
    ).toBe(1);
    expect(await observer.goldenSet.count({ where: { id: set.value.goldenSetId } })).toBe(1);
    expect(await observer.safetyEvent.count({ where: { id: event.value.safetyEventId } })).toBe(1);
    expect(await observer.messageRating.count({ where: { turnId: foreign.turnId } })).toBe(1);
  });
});
