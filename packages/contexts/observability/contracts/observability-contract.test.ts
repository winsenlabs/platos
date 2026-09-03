// The published surface, exercised end to end in memory.
//
// This is the shape `apps/core-api` will hold. If every one of these passes
// against the in-memory doubles, the composition root can be wired without a
// column store, a queue or a database — which is the property that makes the
// contract worth having.

import { asIdentifier, type PrincipalId } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { createObservabilityContract } from "../application/observability-contract.js";
import {
  buildObservabilityTestContext,
  testEnvelope,
  testFinalizedPayload,
  testScope,
  testStep,
  testTurnWork,
  TEST_TOOL_CALL_UUID,
  TEST_TURN_UUID,
  TEST_USAGE_UUID,
  type ObservabilityTestContext,
} from "../application/testing/index.js";
import { sinkHealth, TURN_FINALIZED_EVENT } from "../domain/index.js";
import type { ObservabilityContract } from "./index.js";

describe("ObservabilityContract", () => {
  let context: ObservabilityTestContext;
  let contract: ObservabilityContract;

  beforeEach(() => {
    context = buildObservabilityTestContext();
    contract = createObservabilityContract(context.dependencies);
  });

  it("names itself, so the composition root can key on it", () => {
    expect(contract.name).toBe("observability");
  });

  it("projects a Turn handed to it directly — ALL FOUR lanes, not two", async () => {
    // This case asserted rowCount 2 and ["turns_v1", "steps_v1"] because the
    // fixture hard-coded `toolCalls: []` and `usage: []`. Two of the four
    // analytical tables were therefore never populated by any test in the
    // package, and `usage_events_v1` is the one the bill is computed from.
    const projected = await contract.projectTurn(testTurnWork());
    if (!projected.ok) throw new Error(projected.error.code);
    expect(projected.value.rowCount).toBe(4);
    expect(projected.value.tables).toEqual([
      "turns_v1",
      "steps_v1",
      "tool_calls_v1",
      "usage_events_v1",
    ]);
    expect(projected.value.rows.turns_v1[0]?.turn_id).toBe(TEST_TURN_UUID);
    expect(projected.value.rows.tool_calls_v1[0]?.tool_call_id).toBe(TEST_TOOL_CALL_UUID);
    expect(projected.value.rows.usage_events_v1[0]?.usage_event_id).toBe(TEST_USAGE_UUID);
  });

  it("keeps an EMPTY lane empty when the caller asks for one", async () => {
    // The control on the fixture change above. Populating the default must not
    // make an empty lane unrepresentable, or "a Turn that called no tool" stops
    // being expressible and `populatedTables` stops being exercised on a
    // partial Turn.
    const projected = await contract.projectTurn(testTurnWork({ toolCalls: [], usage: [] }));
    if (!projected.ok) throw new Error(projected.error.code);
    expect(projected.value.rowCount).toBe(2);
    expect(projected.value.tables).toEqual(["turns_v1", "steps_v1"]);
  });

  it("REFUSES a Turn whose parts name more than one environment", async () => {
    const projected = await contract.projectTurn(
      testTurnWork({ steps: [testStep({ scope: testScope("env-2") })] }),
    );
    expect(projected.ok).toBe(false);
    if (projected.ok) throw new Error("unreachable");
    expect(projected.error.code).toBe("OBSERVABILITY_PROJECTION_SCOPE_MISMATCH");
    expect(projected.error.category).toBe("forbidden");
    expect(projected.error.details.part).toBe("steps[0]");
  });

  it("names both scopes in the refusal, so the mismatch is diagnosable", async () => {
    const projected = await contract.projectTurn(
      testTurnWork({ steps: [testStep({ scope: testScope("env-2") })] }),
    );
    if (projected.ok) throw new Error("unreachable");
    expect(projected.error.details.expected).toBe("org/org-1/proj/proj-1/env/env-1");
    expect(projected.error.details.found).toBe("org/org-1/proj/proj-1/env/env-2");
  });

  it("projects without touching the sink or the queue", async () => {
    await contract.projectTurn(testTurnWork());
    expect(context.sink.callsTo("insert")).toHaveLength(0);
    expect(context.outbox.size).toBe(0);
  });

  it("drains the queue and reports what it did", async () => {
    context.outbox.enqueue(testEnvelope(TURN_FINALIZED_EVENT, testFinalizedPayload()));
    const drained = await contract.drainProjections();
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.delivered).toBe(1);
    expect(drained.value.depth).toEqual({ pending: 0, failed: 0 });
  });

  it("accepts a narrowed budget on the drain", async () => {
    for (let index = 0; index < 3; index += 1) {
      context.outbox.enqueue(testEnvelope(TURN_FINALIZED_EVENT, testFinalizedPayload()));
    }
    const drained = await contract.drainProjections({ budget: { maxRows: 2 } });
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.claimed).toBe(2);
  });

  it("describes the sink and the queue", async () => {
    context.sink.health = sinkHealth("unreachable", "timeout");
    const described = await contract.describeStatus();
    if (!described.ok) throw new Error(described.error.code);
    expect(described.value.sink.status).toBe("unreachable");
    expect(described.value.depth).toEqual({ pending: 0, failed: 0 });
  });

  it("records an admin action and reads it back", async () => {
    const recorded = await contract.recordAdminAction({
      scope: testScope(),
      actorUserId: asIdentifier<PrincipalId>("user-1"),
      action: "agent.delete",
      subjectType: "Agent",
      subjectId: "agent-1",
      before: { name: "old" },
      reason: "duplicate",
    });
    if (!recorded.ok) throw new Error(recorded.error.code);
    expect(recorded.value.action).toBe("agent.delete");
    expect(recorded.value.source).toBe("api");

    const trail = await contract.readAdminTrail({ scope: testScope() });
    if (!trail.ok) throw new Error(trail.error.code);
    expect(trail.value).toHaveLength(1);
    expect(trail.value[0]?.before).toEqual({ name: "old" });
    expect(trail.value[0]?.reason).toBe("duplicate");
  });

  it("refuses a malformed admin action across the boundary as a value, not a throw", async () => {
    const recorded = await contract.recordAdminAction({
      scope: testScope(),
      actorUserId: null,
      action: "Not A Name",
      subjectType: "Agent",
    });
    expect(recorded.ok).toBe(false);
    if (recorded.ok) throw new Error("unreachable");
    expect(recorded.error.code).toBe("OBSERVABILITY_AUDIT_ACTION_INVALID");
  });

  it("publishes the ErasureTarget the composition root collects for privacy", async () => {
    const target = contract.erasureTarget();
    expect(target.targetName).toBe("observability");
    const plan = await target.plan({
      subjectKind: "end-user",
      subjectId: "end-user-1",
      scope: testScope(),
    });
    expect(plan.items.map((item) => item.model)).toEqual([
      "turns_v1",
      "steps_v1",
      "tool_calls_v1",
      "usage_events_v1",
      "AdminAudit",
    ]);
  });

  it("returns the SAME target every time, so the root wires one, not one per call", () => {
    expect(contract.erasureTarget()).toBe(contract.erasureTarget());
  });

  it("exposes no domain internals: every published member is on the contract", () => {
    expect(Object.keys(contract).sort()).toEqual(
      [
        "describeStatus",
        "drainProjections",
        "erasureTarget",
        "name",
        "projectTurn",
        "readAdminTrail",
        "recordAdminAction",
      ].sort(),
    );
  });
});
