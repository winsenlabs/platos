import {
  asIdentifier,
  organizationScope,
  type ErasureSubject,
  type TransactionId,
  type TransactionScope,
} from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { MemoryEntityId, MemoryId, MemoryRelationshipId } from "../domain/index.js";
import {
  createMemoryErasureTarget,
  MEMORY_ENTITY_MODEL,
  MEMORY_ERASURE_TARGET_NAME,
  MEMORY_MODEL,
  MEMORY_RELATIONSHIP_MODEL,
  MemoryErasureRejected,
  selectorFor,
} from "./memory-erasure-target.js";
import {
  ENVIRONMENT_SCOPE,
  entityFixture,
  harness,
  memoryFixture,
  relationshipFixture,
  SUBJECT_ID,
  subjectFixture,
  type MemoryHarness,
} from "./testing/fixtures.js";
import type { EndUserId } from "../domain/index.js";

const SUBJECT: ErasureSubject = {
  subjectKind: "end-user",
  subjectId: SUBJECT_ID,
  scope: ENVIRONMENT_SCOPE,
};

const TRANSACTION: TransactionScope = { transactionId: asIdentifier<TransactionId>("txn-1") };

function seedAll(context: MemoryHarness): void {
  context.repository.seed(memoryFixture({ memoryId: asIdentifier<MemoryId>("mem-1") }));
  context.repository.seed(memoryFixture({ memoryId: asIdentifier<MemoryId>("mem-2") }));
  context.graph.seedEntity(entityFixture({ entityId: asIdentifier<MemoryEntityId>("ent-1") }));
  context.graph.seedRelationship(relationshipFixture());
}

describe("the plan", () => {
  it("names this context and its three models", async () => {
    const context = harness();
    seedAll(context);
    const plan = await createMemoryErasureTarget(context.dependencies).plan(SUBJECT);
    expect(plan.targetName).toBe(MEMORY_ERASURE_TARGET_NAME);
    expect(plan.items.map((item) => item.model)).toEqual([
      MEMORY_MODEL,
      MEMORY_ENTITY_MODEL,
      MEMORY_RELATIONSHIP_MODEL,
    ]);
  });

  it("counts what it holds, and every item is a DELETE", async () => {
    const context = harness();
    seedAll(context);
    const plan = await createMemoryErasureTarget(context.dependencies).plan(SUBJECT);
    expect(plan.items.map((item) => item.rowCount)).toEqual([2, 1, 1]);
    for (const item of plan.items) {
      expect(item.method).toBe("delete");
      expect(item.blockedBy).toBeNull();
    }
  });

  it("MUTATES NOTHING", async () => {
    const context = harness();
    seedAll(context);
    await createMemoryErasureTarget(context.dependencies).plan(SUBJECT);
    expect(context.repository.all()).toHaveLength(2);
    expect(context.graph.allEntities()).toHaveLength(1);
  });

  it("reports a ZERO-row plan for an operator `user` subject", async () => {
    const context = harness();
    seedAll(context);
    const plan = await createMemoryErasureTarget(context.dependencies).plan({
      subjectKind: "user",
      subjectId: "operator-1",
      scope: ENVIRONMENT_SCOPE,
    });
    expect(plan.items.every((item) => item.rowCount === 0)).toBe(true);
  });

  it("reports a zero-row plan for an `entity` subject", async () => {
    const context = harness();
    seedAll(context);
    const plan = await createMemoryErasureTarget(context.dependencies).plan({
      subjectKind: "entity",
      subjectId: "ent-1",
      scope: ENVIRONMENT_SCOPE,
    });
    expect(plan.items.every((item) => item.rowCount === 0)).toBe(true);
  });

  it("REJECTS rather than reporting a count it could not read", async () => {
    const context = harness();
    context.repository.failWith("store down");
    await expect(createMemoryErasureTarget(context.dependencies).plan(SUBJECT)).rejects.toBeInstanceOf(
      MemoryErasureRejected,
    );
  });
});

describe("the erasure", () => {
  it("destroys every row and reports the counts it OBSERVED", async () => {
    const context = harness();
    seedAll(context);
    const target = createMemoryErasureTarget(context.dependencies);
    const receipt = await target.erase(await target.plan(SUBJECT), TRANSACTION);
    expect(receipt.targetName).toBe(MEMORY_ERASURE_TARGET_NAME);
    expect(receipt.items.map((item) => item.rowCount)).toEqual([2, 1, 1]);
    expect(context.repository.all()).toHaveLength(0);
    expect(context.graph.allEntities()).toHaveLength(0);
    expect(context.graph.allRelationships()).toHaveLength(0);
  });

  it("leaves ANOTHER subject's rows untouched", async () => {
    const context = harness();
    seedAll(context);
    context.repository.seed(
      memoryFixture({
        memoryId: asIdentifier<MemoryId>("mem-theirs"),
        subject: subjectFixture({ endUserId: asIdentifier<EndUserId>("user-2") }),
      }),
    );
    const target = createMemoryErasureTarget(context.dependencies);
    await target.erase(await target.plan(SUBJECT), TRANSACTION);
    expect(context.repository.all().map((memory) => memory.memoryId)).toEqual(["mem-theirs"]);
  });

  it("REFUSES a plan minted by another target", async () => {
    const context = harness();
    const target = createMemoryErasureTarget(context.dependencies);
    await expect(
      target.erase({ targetName: "files", items: [] }, TRANSACTION),
    ).rejects.toBeInstanceOf(MemoryErasureRejected);
  });

  it("refuses a plan of this context's that lost its subject rider", async () => {
    const context = harness();
    const target = createMemoryErasureTarget(context.dependencies);
    await expect(
      target.erase({ targetName: MEMORY_ERASURE_TARGET_NAME, items: [] }, TRANSACTION),
    ).rejects.toBeInstanceOf(MemoryErasureRejected);
  });

  it("REJECTS rather than issuing a receipt it cannot honour", async () => {
    const context = harness();
    seedAll(context);
    const target = createMemoryErasureTarget(context.dependencies);
    const plan = await target.plan(SUBJECT);
    context.graph.failWith("graph down");
    await expect(target.erase(plan, TRANSACTION)).rejects.toBeInstanceOf(MemoryErasureRejected);
  });

  // THE CASE THAT SEPARATES A FORECAST FROM AN OBSERVATION.
  //
  // Every other case in this file erases a store that has not moved since the
  // plan was taken, so `plan.items` and the counts the deletes returned are the
  // SAME NUMBERS. A receipt built straight from `plan.items` is indistinguishable
  // from one built from what the deletes reported, and the file header's whole
  // argument for deleting relationships explicitly — "a cascade reports nothing,
  // and a receipt that claimed a count it did not observe would be a receipt
  // nobody can audit" — is untested.
  //
  // These two cases move the store BETWEEN plan() and erase(), in both
  // directions, so the two numbers differ and only the observed one is right.
  it("reports what the DELETES returned when rows arrived after the plan", async () => {
    const context = harness();
    seedAll(context);
    const target = createMemoryErasureTarget(context.dependencies);

    const plan = await target.plan(SUBJECT);
    expect(plan.items.map((item) => item.rowCount)).toEqual([2, 1, 1]);

    // The subject keeps talking while the erasure is being adjudicated: one more
    // memory, one more entity, one more edge. A real operation is not atomic
    // between planning and executing, which is exactly why the receipt has to be
    // an observation.
    context.repository.seed(memoryFixture({ memoryId: asIdentifier<MemoryId>("mem-3") }));
    context.graph.seedEntity(entityFixture({ entityId: asIdentifier<MemoryEntityId>("ent-2") }));
    context.graph.seedRelationship(
      relationshipFixture({ relationshipId: asIdentifier<MemoryRelationshipId>("rel-2") }),
    );

    const receipt = await target.erase(plan, TRANSACTION);

    // The FORECAST is [2, 1, 1]. The OBSERVATION is [3, 2, 2]. A receipt that
    // handed back `plan.items` would understate a destruction by three rows.
    expect(receipt.items.map((item) => item.rowCount)).toEqual([3, 2, 2]);
    expect(receipt.items.map((item) => item.model)).toEqual([
      MEMORY_MODEL,
      MEMORY_ENTITY_MODEL,
      MEMORY_RELATIONSHIP_MODEL,
    ]);
    // And the store really is empty, so the larger number is the true one.
    expect(context.repository.all()).toHaveLength(0);
    expect(context.graph.allEntities()).toHaveLength(0);
    expect(context.graph.allRelationships()).toHaveLength(0);
  });

  it("reports ZEROS when the rows are already gone, never the plan's forecast", async () => {
    // The other direction, and the worse one to get wrong: a receipt that claims
    // rows it did not destroy. The same plan is replayed against a store the
    // first erasure already emptied.
    const context = harness();
    seedAll(context);
    const target = createMemoryErasureTarget(context.dependencies);

    const plan = await target.plan(SUBJECT);
    const first = await target.erase(plan, TRANSACTION);
    expect(first.items.map((item) => item.rowCount)).toEqual([2, 1, 1]);

    const second = await target.erase(plan, TRANSACTION);
    expect(second.items.map((item) => item.rowCount)).toEqual([0, 0, 0]);
  });

  it("issues an EMPTY receipt for a subject it holds nothing for", async () => {
    const context = harness();
    const target = createMemoryErasureTarget(context.dependencies);
    const receipt = await target.erase(
      await target.plan({ subjectKind: "user", subjectId: "operator-1", scope: ENVIRONMENT_SCOPE }),
      TRANSACTION,
    );
    expect(receipt.items.every((item) => item.rowCount === 0)).toBe(true);
  });
});

// THREE OF THE SIX FAIL-CLOSED BRANCHES WERE DECORATIVE.
//
// The two cases above reach exactly two of them: `repository.failWith` before
// the plan reaches `countMemoriesForSubject`, and `graph.failWith` after the
// plan reaches `deleteRelationshipsForSubject`. A whole-store outage cannot
// reach any LATER branch, because the first failure short-circuits the rest —
// so neutralising `countEntitiesForSubject`'s, `deleteEntitiesForSubject`'s or
// `deleteMemoriesForSubject`'s refusal left all 602 tests green while producing
// precisely what `MemoryErasureRejected`'s docblock forbids:
//
//   a count that failed  -> a plan reporting ZERO rows, so `privacy` adjudicates
//                           an erasure against a subject who looks empty.
//   a delete that failed -> a receipt carrying the PLAN's counts, which is "a
//                           receipt claiming a row was destroyed when it was
//                           not" — the one outcome the class exists to prevent.
//
// `failErasureWith` fails ONE method, which is what makes each branch reachable
// on its own. All six are pinned here, in the order they run, and every one
// asserts a REJECTION rather than a plan or a receipt.
describe("every fail-closed branch, one at a time", () => {
  it.each([
    ["countMemoriesForSubject", "repository"],
    ["countEntitiesForSubject", "graph"],
    ["countRelationshipsForSubject", "graph"],
  ] as const)("REJECTS the plan when %s fails, rather than reporting zero", async (method, store) => {
    const context = harness();
    seedAll(context);
    if (store === "repository") context.repository.failErasureWith(method, "store down");
    else context.graph.failErasureWith(method, "store down");
    await expect(createMemoryErasureTarget(context.dependencies).plan(SUBJECT)).rejects.toBeInstanceOf(
      MemoryErasureRejected,
    );
  });

  it.each([
    ["deleteRelationshipsForSubject", "graph"],
    ["deleteEntitiesForSubject", "graph"],
    ["deleteMemoriesForSubject", "repository"],
  ] as const)("REJECTS rather than issuing a receipt when %s fails", async (method, store) => {
    const context = harness();
    seedAll(context);
    const target = createMemoryErasureTarget(context.dependencies);
    const plan = await target.plan(SUBJECT);
    if (store === "repository") context.repository.failErasureWith(method, "store down");
    else context.graph.failErasureWith(method, "store down");
    await expect(target.erase(plan, TRANSACTION)).rejects.toBeInstanceOf(MemoryErasureRejected);
  });
});

describe("selectorFor", () => {
  it("matches only an END-USER subject", () => {
    expect(selectorFor(SUBJECT)?.endUserId).toBe(SUBJECT_ID);
    expect(selectorFor({ subjectKind: "user", subjectId: "op", scope: ENVIRONMENT_SCOPE })).toBeNull();
    expect(selectorFor({ subjectKind: "entity", subjectId: "e", scope: ENVIRONMENT_SCOPE })).toBeNull();
  });

  it("requires an ENVIRONMENT scope — every row here is environment-keyed", () => {
    expect(
      selectorFor({
        subjectKind: "end-user",
        subjectId: SUBJECT_ID,
        scope: organizationScope(asIdentifier("org-1")),
      }),
    ).toBeNull();
  });
});
