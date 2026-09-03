import {
  asIdentifier,
  type PrincipalId,
  type TransactionId,
  type TransactionScope,
} from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX } from "../domain/index.js";
import {
  readAdminTrail,
  recordAdminAction,
  recordAdminActionBestEffort,
} from "./record-admin-action.js";
import {
  buildObservabilityTestContext,
  testScope,
  type ObservabilityTestContext,
} from "./testing/index.js";

const TRANSACTION: TransactionScope = { transactionId: asIdentifier<TransactionId>("txn-caller") };

function action(overrides: Record<string, unknown> = {}) {
  return {
    scope: testScope(),
    actorUserId: asIdentifier<PrincipalId>("user-1"),
    action: "agent.delete",
    subjectType: "Agent",
    subjectId: "agent-1",
    ...overrides,
  } as Parameters<typeof recordAdminActionBestEffort>[1];
}

describe("recordAdminAction — joins the caller's transaction", () => {
  let context: ObservabilityTestContext;

  beforeEach(() => {
    context = buildObservabilityTestContext();
  });

  it("writes the row inside the transaction it was given", async () => {
    const recorded = await recordAdminAction(context.dependencies, action(), TRANSACTION);
    if (!recorded.ok) throw new Error(recorded.error.code);
    expect(context.repository.transactions).toEqual([TRANSACTION]);
    expect(context.repository.size).toBe(1);
  });

  it("mints the id from the port, so the record is reproducible", async () => {
    const first = await recordAdminAction(context.dependencies, action(), TRANSACTION);
    const second = await recordAdminAction(context.dependencies, action(), TRANSACTION);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(first.value.adminAuditId).toBe("id-0001");
    expect(second.value.adminAuditId).toBe("id-0002");
  });

  it("stamps the time from the clock port, not the wall clock", async () => {
    context.clock.set(new Date("2030-06-01T12:00:00.000Z"));
    const recorded = await recordAdminAction(context.dependencies, action(), TRANSACTION);
    if (!recorded.ok) throw new Error(recorded.error.code);
    expect(recorded.value.recordedAt).toEqual(new Date("2030-06-01T12:00:00.000Z"));
  });

  it("refuses a malformed record BEFORE touching the repository", async () => {
    const recorded = await recordAdminAction(context.dependencies, action({ action: "" }), TRANSACTION);
    expect(recorded.ok).toBe(false);
    expect(context.repository.size).toBe(0);
    expect(context.repository.transactions).toHaveLength(0);
  });

  it("returns the write failure rather than swallowing it", async () => {
    context.repository.writeFails = true;
    const recorded = await recordAdminAction(context.dependencies, action(), TRANSACTION);
    expect(recorded.ok).toBe(false);
    if (recorded.ok) throw new Error("unreachable");
    expect(recorded.error.code).toBe("OBSERVABILITY_REPOSITORY_UNAVAILABLE");
  });
});

describe("recordAdminActionBestEffort — opens its own transaction", () => {
  let context: ObservabilityTestContext;

  beforeEach(() => {
    context = buildObservabilityTestContext();
  });

  it("writes in a transaction of its own", async () => {
    const recorded = await recordAdminActionBestEffort(context.dependencies, action());
    if (!recorded.ok) throw new Error(recorded.error.code);
    expect(context.unitOfWork.transactions).toHaveLength(1);
    expect(context.repository.transactions).toEqual(context.unitOfWork.transactions);
  });

  it("makes a failed write VISIBLE in the return value, never a silent void", async () => {
    context.repository.writeFails = true;
    const recorded = await recordAdminActionBestEffort(context.dependencies, action());
    expect(recorded.ok).toBe(false);
    expect(context.logger.at("error")).toHaveLength(1);
  });

  it("validates before opening a transaction", async () => {
    const recorded = await recordAdminActionBestEffort(context.dependencies, action({ action: "Bad Name" }));
    expect(recorded.ok).toBe(false);
    expect(context.unitOfWork.transactions).toHaveLength(0);
  });

  it("records a scheduled action with no actor at all", async () => {
    const recorded = await recordAdminActionBestEffort(
      context.dependencies,
      action({ actorUserId: null, source: "scheduled" }),
    );
    if (!recorded.ok) throw new Error(recorded.error.code);
    expect(recorded.value.actorUserId).toBeNull();
    expect(recorded.value.source).toBe("scheduled");
  });
});

describe("readAdminTrail", () => {
  let context: ObservabilityTestContext;

  beforeEach(async () => {
    context = buildObservabilityTestContext();
    for (const subjectId of ["agent-1", "agent-2", "agent-3"]) {
      await recordAdminActionBestEffort(context.dependencies, action({ subjectId }));
      context.clock.advanceSeconds(1);
    }
  });

  it("returns the trail newest first", async () => {
    const found = await readAdminTrail(context.dependencies, { query: { scope: testScope() } });
    if (!found.ok) throw new Error(found.error.code);
    expect(found.value.map((record) => record.subjectId)).toEqual(["agent-3", "agent-2", "agent-1"]);
  });

  it("never crosses the scope it was given", async () => {
    const found = await readAdminTrail(context.dependencies, { query: { scope: testScope("env-2") } });
    if (!found.ok) throw new Error(found.error.code);
    expect(found.value).toHaveLength(0);
  });

  it("filters by subject", async () => {
    const found = await readAdminTrail(context.dependencies, {
      query: { scope: testScope(), subjectId: "agent-2" },
    });
    if (!found.ok) throw new Error(found.error.code);
    expect(found.value).toHaveLength(1);
  });

  it("bounds an unbounded request rather than reading the whole table", async () => {
    const found = await readAdminTrail(context.dependencies, {
      query: { scope: testScope(), limit: 10_000 },
    });
    if (!found.ok) throw new Error(found.error.code);
    // The repository received the CAPPED limit, not the caller's. Counting the
    // returned rows could not tell a cap from a small table.
    expect(context.repository.queries[0]?.limit).toBe(AUDIT_PAGE_MAX);
  });

  it("resolves an absent limit to the default before the repository sees it", async () => {
    await readAdminTrail(context.dependencies, { query: { scope: testScope() } });
    expect(context.repository.queries[0]?.limit).toBe(AUDIT_PAGE_DEFAULT);
  });

  it("honours a smaller limit", async () => {
    const found = await readAdminTrail(context.dependencies, {
      query: { scope: testScope(), limit: 2 },
    });
    if (!found.ok) throw new Error(found.error.code);
    expect(found.value).toHaveLength(2);
  });

  it("returns the read failure rather than an empty page", async () => {
    context.repository.readFails = true;
    const found = await readAdminTrail(context.dependencies, { query: { scope: testScope() } });
    expect(found.ok).toBe(false);
  });
});
