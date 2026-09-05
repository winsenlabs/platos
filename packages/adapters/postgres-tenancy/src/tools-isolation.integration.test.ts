// Tenant isolation and transcript integrity, against a real tree.
//
// EVERY CASE IN THIS FILE EXISTS BECAUSE A MUTATION SURVIVED. The tranche-5
// sweep recorded in `../mutations-tools.json` removed each of the guards below
// one at a time and this store's own five suites stayed green for all of them:
// the ancestry resolve could drop its organization half, an environment that
// does not exist could be admitted, `replaceExposures` could delete another
// entity's rows, `setExposureEnabled` could lose its tenant clause, and a
// transcript could come back backwards or be moved to another step. Each was a
// guard nothing could falsify, which is the same as no guard at all.
//
// THEY ARE NOT IN `tools-constraints.integration.test.ts` and the reason is the
// ADR M0.3 §6 budget rather than taste: appending them took that file to 467
// effective lines, inside the warning band and heading for the 500 hard limit,
// and the seam the budget was pointing at is real. That file is about rules
// that live ONLY IN THE MIGRATIONS — a CHECK, an ancestry trigger, a
// NULL-distinct index. This one is about what the STORE decides: which rows a
// statement may reach, and which columns a second write may not move.
//
// The in-memory double cannot state any of it. It compares `resolvePath(scope)`
// against the one scope it was constructed with, so a forged ancestry and a
// deleted environment are the same event to it, and it holds no second entity
// under one environment to be isolated from.
//
// Run by `pnpm test:postgres-tenancy:integration`. FAILS when Docker is absent.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  StepId,
  ToolCall,
  ToolCallId,
  ToolId,
  ToolHealthId,
  SchemaHash,
} from "@platos/context-tools/application/ports/index.js";
import { asToolsIdentifier } from "@platos/context-tools/application/ports/index.js";

import { TOOLS_AT } from "./tools-conformance.js";
import type { SeededToolsTenant, ToolsHarness } from "./tools-harness.js";
import {
  startToolsHarness,
  toolsEntityId,
  toolsName,
  toolsSchemaHash,
} from "./tools-harness.js";

let harness: ToolsHarness;
let tenant: SeededToolsTenant;
let other: SeededToolsTenant;
let sequence = 0;

beforeAll(async () => {
  harness = await startToolsHarness();
  tenant = harness.first;
  other = harness.second;
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

function freshHash(): SchemaHash {
  sequence += 1;
  return toolsSchemaHash(`b${sequence.toString(16).padStart(15, "0")}`);
}

async function mintTool(name: string): Promise<ToolId> {
  const minted = await harness.repository.upsertTool({
    name: toolsName(name),
    description: `the ${name} tool`,
    paramSchema: { type: "object" },
    category: "test",
    schemaHash: freshHash(),
  });
  if (!minted.ok) throw new Error(`could not mint ${name}: ${minted.error.code}`);
  return minted.value.toolId;
}

/** The refusal reason a `Result` carries, or what it answered instead. */
function reason(result: {
  readonly ok: boolean;
  readonly error?: { details: Record<string, unknown> };
}): unknown {
  return result.ok ? "<accepted>" : (result.error?.details.reason ?? null);
}

describe("the ancestry the scope claims, resolved against the real tree", () => {
  test("an environment under ANOTHER organization is refused, and the leaf is real", async () => {
    // The re-parenting case the port's note is about. The environment and the
    // project are this tenant's and BOTH EXIST; only the organization is
    // another tenant's. A `where` clause keyed on the leaf alone — or on the
    // leaf and its project — answers this happily, which is why the resolve
    // compares all three.
    const forged = { ...tenant.scope, organizationId: asToolsIdentifier(other.organizationId) };
    const refused = await harness.repository.listExposures(forged);
    expect(refused.ok).toBe(false);
    expect(reason(refused)).toBe("out_of_scope:listExposures");
  }, 120_000);

  test("an environment under ANOTHER project is refused the same way", async () => {
    const forged = { ...tenant.scope, projectId: asToolsIdentifier(other.projectId) };
    const refused = await harness.repository.listAgentPolicyBindings(forged);
    expect(refused.ok).toBe(false);
    expect(reason(refused)).toBe("out_of_scope:listAgentPolicyBindings");
  }, 120_000);

  test("an environment that does not exist is a DIFFERENT refusal from a forged one", async () => {
    // Two guards returning ONE code could not be told apart, and an operator
    // reading a log would not know whether the ancestry was forged or the
    // environment was deleted. The double cannot mint this one at all: it holds
    // no tree, which is exactly why it is minted here.
    const absent = {
      ...tenant.scope,
      environmentId: asToolsIdentifier("eeeeeeee-0000-4000-8000-eeeeeeeeeeee"),
    };
    const missing = await harness.repository.listExposures(absent);
    expect(missing.ok).toBe(false);
    expect(reason(missing)).toBe("unknown_environment:listExposures");

    const forged = await harness.repository.listExposures({
      ...tenant.scope,
      organizationId: asToolsIdentifier(other.organizationId),
    });
    expect(reason(forged)).not.toBe(reason(missing));
  }, 120_000);
});

describe("what one entity's registration may reach", () => {
  test("re-registering ONE entity leaves the other entity's exposures alone", async () => {
    const scoped = await harness.seedToolsTenant("replace-isolation");
    const wire = toolsEntityId(scoped.wireEntityId);
    const mcp = toolsEntityId(scoped.mcpEntityId);
    const alpha = await mintTool("isolation.alpha");
    const beta = await mintTool("isolation.beta");
    const both = { scope: scoped.scope, callbackUrl: "https://backend.example.test/hooks" };

    expect(
      (await harness.repository.replaceExposures({ ...both, entityId: wire, toolIds: [alpha] })).ok,
    ).toBe(true);
    expect(
      (await harness.repository.replaceExposures({ ...both, entityId: mcp, toolIds: [beta] })).ok,
    ).toBe(true);

    // THE INJECTION: the wire entity re-registers and drops alpha. Only the
    // WIRE entity's row may go. A delete keyed on the environment and the tool
    // set alone would take the mcp entity's beta with it, and every value this
    // call returns would still be correct — which is why the assertion below is
    // on the OTHER entity rather than on what the call answered.
    expect(
      (await harness.repository.replaceExposures({ ...both, entityId: wire, toolIds: [] })).ok,
    ).toBe(true);

    const surviving = await harness.repository.listEntityExposures(scoped.scope, mcp);
    expect(surviving.ok).toBe(true);
    expect(surviving.ok ? surviving.value.map((row) => row.toolId) : []).toEqual([beta]);
  }, 120_000);

  test("an exposure id from another environment cannot be switched off", async () => {
    const mine = await harness.seedToolsTenant("enable-mine");
    const theirs = await harness.seedToolsTenant("enable-theirs");
    const tool = await mintTool("enable.crossing");
    const registered = await harness.repository.replaceExposures({
      scope: theirs.scope,
      entityId: toolsEntityId(theirs.wireEntityId),
      callbackUrl: "https://backend.example.test/hooks",
      toolIds: [tool],
    });
    expect(registered.ok).toBe(true);
    const exposureId = registered.ok ? registered.value[0]?.exposureId : undefined;
    if (exposureId === undefined) throw new Error("the fixture registered no exposure");

    // `update` addresses the primary key ALONE; only `updateMany` can carry the
    // tenant clause in the statement. Guessing the id must not be enough.
    const refused = await harness.repository.setExposureEnabled(mine.scope, exposureId, false);
    expect(refused.ok).toBe(false);

    // And the row is untouched, read on the client this adapter's pool never
    // used — the refusal is not the test, the row is.
    expect(await harness.durableExposures(theirs.scope.environmentId)).toEqual([
      { toolId: tool, enabled: true },
    ]);
  }, 120_000);
});

describe("orders and instants a transcript may not lose", () => {
  test("a step's calls come back in SEQUENCE order, whatever order they were written", async () => {
    const scoped = await harness.seedToolsTenant("transcript-order");
    const stepId = asToolsIdentifier<StepId>(scoped.stepId);
    const tool = await mintTool("order.tool");
    const call = (ordinal: number, id: string): ToolCall => ({
      toolCallId: asToolsIdentifier<ToolCallId>(id),
      stepId,
      toolId: tool,
      sequence: ordinal,
      toolName: toolsName("order.tool"),
      arguments: {},
      result: null,
      status: "PENDING",
      retryCount: 0,
      error: null,
      latencyMs: null,
      startedAt: null,
      completedAt: null,
      createdAt: TOOLS_AT,
    });
    // Written 3, 1, 2, so insertion order and sequence order DISAGREE and the
    // ORDER BY is the only thing that can produce the right answer.
    for (const [ordinal, id] of [
      [3, "77777777-0003-4000-8000-000000000003"],
      [1, "77777777-0001-4000-8000-000000000001"],
      [2, "77777777-0002-4000-8000-000000000002"],
    ] as const) {
      expect((await harness.repository.saveCall(scoped.scope, call(ordinal, id))).ok).toBe(true);
    }
    const listed = await harness.repository.listStepCalls(scoped.scope, stepId);
    expect(listed.ok).toBe(true);
    expect(listed.ok ? listed.value.map((row) => row.sequence) : []).toEqual([1, 2, 3]);
  }, 120_000);

  test("re-saving a call may not move it to another step or another instant", async () => {
    const scoped = await harness.seedToolsTenant("transcript-immutable");
    const stepId = asToolsIdentifier<StepId>(scoped.stepId);
    const movedTo = asToolsIdentifier<StepId>(await harness.seedStep(scoped, 1));
    const tool = await mintTool("immutable.tool");
    const original: ToolCall = {
      toolCallId: asToolsIdentifier<ToolCallId>("88888888-0001-4000-8000-000000000001"),
      stepId,
      toolId: tool,
      sequence: 1,
      toolName: toolsName("immutable.tool"),
      arguments: {},
      result: null,
      status: "PENDING",
      retryCount: 0,
      error: null,
      latencyMs: null,
      startedAt: null,
      completedAt: null,
      createdAt: TOOLS_AT,
    };
    expect((await harness.repository.saveCall(scoped.scope, original)).ok).toBe(true);

    // The same call id, now claiming a different step and a different instant.
    // A call belongs to the step it was made in; moving one rewrites a
    // transcript. The status update it is RIDING ON must still land, or this
    // case would also pass against a store that ignored the second write.
    const rewritten = await harness.repository.saveCall(scoped.scope, {
      ...original,
      stepId: movedTo,
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
      status: "SUCCEEDED",
    });
    expect(rewritten.ok).toBe(true);
    expect(rewritten.ok ? rewritten.value.stepId : null).toBe(stepId);
    expect(rewritten.ok ? rewritten.value.createdAt.toISOString() : null).toBe(
      TOOLS_AT.toISOString(),
    );
    expect(rewritten.ok ? rewritten.value.status : null).toBe("SUCCEEDED");
  }, 120_000);
});

describe("the health row a NULL entity may hold twice", () => {
  test("findHealth pins the LOWEST id when two rows match, not an arbitrary one", async () => {
    // `entityExternalId` is nullable and the unique index is NULL-DISTINCT, so
    // two health rows for one (environment, tool) with no entity BOTH stand —
    // which is why the read is `findFirst` and not `findUnique`, and why it
    // carries an ORDER BY at all. Without one the row a caller folds into is
    // whichever the planner happened to return, and a fold that alternates
    // between two rows loses counts on every other turn.
    //
    // The double cannot state this: it has no NULL-distinct index and holds one
    // record per key.
    const scoped = await harness.seedToolsTenant("health-null-twice");
    const tool = await mintTool("health.nullentity");
    const lower = "00000000-0000-4000-8000-00000000aaaa";
    const higher = "ffffffff-0000-4000-8000-00000000ffff";

    // Written HIGHER FIRST, so insertion order and id order disagree.
    for (const [id, totalCalls] of [
      [higher, 9],
      [lower, 1],
    ] as const) {
      const saved = await harness.repository.saveHealth(scoped.scope, {
        toolHealthId: asToolsIdentifier<ToolHealthId>(id),
        environmentId: scoped.scope.environmentId,
        toolId: tool,
        entityExternalId: null,
        lastCalledAt: TOOLS_AT,
        lastStatus: "success",
        failCount: 0,
        totalCalls,
        totalFailures: 0,
        avgLatencyMs: 5,
        p95LatencyMs: null,
      });
      expect(saved.ok).toBe(true);
    }
    // Both rows really are there — the non-vacuity control. If the index had
    // collapsed them this case would pass over a database holding one row.
    expect((await harness.durableHealth(scoped.scope.environmentId, tool)).length).toBe(2);

    const found = await harness.repository.findHealth(scoped.scope, tool, null);
    expect(found.ok).toBe(true);
    expect(found.ok && found.value !== null ? found.value.toolHealthId : null).toBe(lower);
    expect(found.ok && found.value !== null ? found.value.totalCalls : null).toBe(1);
  }, 120_000);
});
