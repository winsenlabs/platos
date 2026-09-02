import {
  asIdentifier,
  organizationScope,
  type ErasureSubject,
  type TransactionId,
  type TransactionScope,
} from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { MemoryEntityId, MemoryId } from "../domain/index.js";
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
