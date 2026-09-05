// The `tools` conformance differential: the in-memory double and this adapter,
// asked the SAME questions against a REAL PostgreSQL, compared verbatim.
//
// WHY THE COMPARISON IS THE TEST. A suite written against the adapter alone
// asserts what its author believed; a suite written against the double alone
// asserts nothing about the database. Running one scenario twice and comparing
// the observation maps makes a divergence a named step with a value on each
// side — and it earned that here too: the four cases below the differential are
// disagreements this comparison surfaced, each pinned on BOTH stores so the
// finding survives whichever one is changed.
//
// Excluded from `vitest run` by the package's own test script and run by
// `pnpm test:postgres-tenancy:integration` in its own CI job. It FAILS when
// Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { InMemoryToolsRepository } from "@platos/context-tools/application/testing/index.js";
import type {
  EntityId,
  EntityToolPolicy,
  ExposureId,
  ToolHealth,
  ToolId,
  ToolsRepository,
} from "@platos/context-tools/application/ports/index.js";
import {
  asToolsIdentifier,
  EMPTY_AUDIT_ENVELOPE as EMPTY_ENVELOPE,
} from "@platos/context-tools/application/ports/index.js";

import type { ToolsConformanceIds } from "./tools-conformance.js";
import { runToolsConformance, TOOLS_AT } from "./tools-conformance.js";
import type { ToolsHarness } from "./tools-harness.js";
import {
  startToolsHarness,
  toolsActorId,
  toolsAgentId,
  toolsCredentialId,
  toolsCredentialName,
  toolsEndUserId,
  toolsEntityId,
  toolsExternalId,
  toolsName,
  toolsSchemaHash,
  toolsThreadId,
} from "./tools-harness.js";

let harness: ToolsHarness;
let ids: ToolsConformanceIds;

const ABSENT_EXPOSURE = asToolsIdentifier<ExposureId>("00000000-0000-4000-8000-0000000000aa");

beforeAll(async () => {
  harness = await startToolsHarness();
  const first = harness.first;
  ids = {
    scope: first.scope,
    // A REAL environment under the WRONG project: the second tenant's. A store
    // that compared the leaf alone would answer it.
    foreignScope: { ...first.scope, projectId: harness.second.scope.projectId },
    entityId: toolsEntityId(first.wireEntityId),
    stepId: first.stepId,
    endUserId: first.endUserId,
    agentId: first.agentId,
    threadId: first.threadId,
    credentialId: first.credentialId,
    credentialName: first.credentialName,
    absentExposureId: ABSENT_EXPOSURE,
  };
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("the shared conformance scenario", () => {
  test("the postgres adapter and the in-memory double answer it identically", async () => {
    const double = new InMemoryToolsRepository(ids.scope);
    // The ONE thing the double has to be told: the environment really does hold
    // an agent binding, because the harness seeded one. A double whose binding
    // set is empty answers a different question about `allowedAgentIds` — and
    // the difference would be the double's silence, not the adapter's error.
    double.seedBindings([
      {
        agentId: toolsAgentId(harness.first.agentId),
        agentVersionId: asToolsIdentifier(harness.first.agentVersionId),
        defaultPolicy: "NONE",
        policies: [],
      },
    ]);

    const doubleObserved = await runToolsConformance(double, ids);
    const realObserved = await runToolsConformance(harness.repository, ids);

    expect(realObserved).toEqual(doubleObserved);
    // Non-vacuity: the scenario has to have observed something, and the values
    // the rest of this tranche turns on are pinned by value rather than by
    // agreement — two stores can agree on nothing at all.
    expect(Object.keys(realObserved).length).toBeGreaterThan(40);
    expect(realObserved.reMintIsTheSameRow).toBe(true);
    expect(realObserved.reMintKeptDescription).toBe(true);
    expect(realObserved.afterNarrowing).toEqual(["beta.write"]);
    expect(realObserved.pageNames).toEqual([["alpha.search"], ["beta.write"]]);
    expect(realObserved.foreignListExposures).toEqual({
      code: "TOOLS_REPOSITORY_UNAVAILABLE",
      reason: "out_of_scope:listExposures",
    });
  }, 300_000);
});

// ---------------------------------------------------------------------------
// THE FOUR DISAGREEMENTS, pinned on both stores.
//
// Each is left OUT of the shared scenario because the two answers differ, and
// each is a finding rather than noise. Pinning them on BOTH sides is what makes
// them survive: a change to either store that closed the gap would turn one of
// these red and force the question to be answered rather than forgotten.
// ---------------------------------------------------------------------------

describe("what the two stores disagree about", () => {
  test("re-registration re-enables a disabled exposure in the double and not here", async () => {
    const tenant = await harness.seedToolsTenant("disagree-enabled");
    const entityId = toolsEntityId(tenant.wireEntityId);
    const tool = await harness.repository.upsertTool({
      name: toolsName("gamma.read"),
      description: "read gamma",
      paramSchema: { type: "object" },
      category: "read",
      schemaHash: toolsSchemaHash("aaaabbbbccccdddd"),
    });
    expect(tool.ok).toBe(true);
    if (!tool.ok) return;

    const written = await harness.repository.replaceExposures({
      scope: tenant.scope,
      entityId,
      callbackUrl: "https://backend.example.test/hooks",
      toolIds: [tool.value.toolId],
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const exposureId = written.value[0]?.exposureId as ExposureId;
    await harness.repository.setExposureEnabled(tenant.scope, exposureId, false);

    const again = await harness.repository.replaceExposures({
      scope: tenant.scope,
      entityId,
      callbackUrl: "https://backend.example.test/hooks",
      toolIds: [tool.value.toolId],
    });
    expect(again.ok && again.value[0]?.enabled).toBe(false);

    // The double, given the same three calls, answers `true`. `enabled` is an
    // operator's kill switch and a backend re-announcing its catalogue is not an
    // operator, so this adapter preserves it — and says so here rather than
    // quietly diverging.
    const double: ToolsRepository = doubleWithTool(tenant.scope, tool.value.toolId);
    const doubleWritten = await double.replaceExposures({
      scope: tenant.scope,
      entityId,
      callbackUrl: "https://backend.example.test/hooks",
      toolIds: [tool.value.toolId],
    });
    expect(doubleWritten.ok).toBe(true);
    if (!doubleWritten.ok) return;
    await double.setExposureEnabled(
      tenant.scope,
      doubleWritten.value[0]?.exposureId as ExposureId,
      false,
    );
    const doubleAgain = await double.replaceExposures({
      scope: tenant.scope,
      entityId,
      callbackUrl: "https://backend.example.test/hooks",
      toolIds: [tool.value.toolId],
    });
    expect(doubleAgain.ok && doubleAgain.value[0]?.enabled).toBe(true);
  }, 120_000);

  test("a null EntityToolPolicy.addedAt keeps its null in the double and gets an instant here", async () => {
    const tenant = await harness.seedToolsTenant("disagree-addedat");
    const tool = await harness.repository.upsertTool({
      name: toolsName("delta.read"),
      description: "read delta",
      paramSchema: { type: "object" },
      category: "read",
      schemaHash: toolsSchemaHash("1111222233334444"),
    });
    if (!tool.ok) return;
    const policy: EntityToolPolicy = {
      entityToolPolicyId: asToolsIdentifier("<minted>"),
      environmentId: tenant.scope.environmentId,
      entityId: toolsEntityId(tenant.wireEntityId),
      toolId: tool.value.toolId,
      toolName: toolsName("delta.read"),
      effect: "ALLOW",
      minIdentityMode: "anonymous",
      scopeLabels: [],
      allowedPatIds: [],
      addedBy: asToolsIdentifier("system"),
      // The record permits null — "a synthesized denial, nothing was ever
      // written". The COLUMN is `NOT NULL DEFAULT now()`.
      addedAt: null,
      lastReviewedAt: null,
    };
    const written = await harness.repository.upsertEntityToolPolicy(policy);
    expect(written.ok && written.value.addedAt).toBeInstanceOf(Date);

    const double = new InMemoryToolsRepository(tenant.scope);
    const doubleWritten = await double.upsertEntityToolPolicy(policy);
    expect(doubleWritten.ok && doubleWritten.value.addedAt).toBeNull();
  }, 120_000);

  test("a null entityExternalId dedupes in the double and does NOT in PostgreSQL", async () => {
    const tenant = await harness.seedToolsTenant("disagree-health");
    const tool = await harness.repository.upsertTool({
      name: toolsName("epsilon.read"),
      description: "read epsilon",
      paramSchema: { type: "object" },
      category: "read",
      schemaHash: toolsSchemaHash("5555666677778888"),
    });
    if (!tool.ok) return;

    const base = (id: string): ToolHealth => ({
      toolHealthId: asToolsIdentifier(id),
      environmentId: tenant.scope.environmentId,
      toolId: tool.value.toolId,
      // NULL. The unique index is NULLS DISTINCT, so two rows do not collide.
      entityExternalId: null,
      lastCalledAt: TOOLS_AT,
      lastStatus: "success",
      failCount: 0,
      totalCalls: 1,
      totalFailures: 0,
      avgLatencyMs: 10,
      p95LatencyMs: null,
      updatedAt: TOOLS_AT,
    });
    await harness.repository.saveHealth(tenant.scope, base("44444444-5555-4666-8777-888888888881"));
    await harness.repository.saveHealth(tenant.scope, base("44444444-5555-4666-8777-888888888882"));
    const rows = await harness.durableHealth(tenant.scope.environmentId, tool.value.toolId);
    // TWO. The compound key `@@unique([environmentId, toolId, entityExternalId])`
    // does not bind when the third column is null, and the generated client
    // types that column as `string` so the key cannot even be named for such a
    // row. The fix is a partial unique index in a migration; this adapter may
    // not write one, so the fact is pinned here.
    expect(rows).toHaveLength(2);

    const double = new InMemoryToolsRepository(tenant.scope);
    await double.saveHealth(tenant.scope, base("44444444-5555-4666-8777-888888888881"));
    await double.saveHealth(tenant.scope, base("44444444-5555-4666-8777-888888888882"));
    const held = await double.findHealth(tenant.scope, tool.value.toolId, null);
    // ONE, and it is the second: the double's `healthKey` encodes null as its
    // own case, so the pair collides in memory and does not in the database.
    expect(held.ok && held.value?.toolHealthId).toBe("44444444-5555-4666-8777-888888888882");
  }, 120_000);

  test("the double implements one of the five AuditQuery filters and this adapter implements five", async () => {
    const tenant = await harness.seedToolsTenant("disagree-audit");
    const older = new Date(Date.now() - 90 * 86_400_000);
    await harness.seedLegacyAudit({
      environmentId: tenant.scope.environmentId,
      toolName: "zeta.old",
      argumentsValue: { q: "old" },
      createdAt: older,
    });
    const inWindow = await harness.repository.pageAudit(tenant.scope, {
      sinceDays: 30,
      limit: 10,
      offset: 0,
      toolName: null,
      agentId: null,
      threadId: null,
      status: null,
    });
    expect(inWindow.ok && inWindow.value).toHaveLength(0);
    const wideWindow = await harness.repository.pageAudit(tenant.scope, {
      sinceDays: 3_650,
      limit: 10,
      offset: 0,
      toolName: null,
      agentId: null,
      threadId: null,
      status: null,
    });
    expect(wideWindow.ok && wideWindow.value).toHaveLength(1);

    // The double ignores `sinceDays`, `agentId`, `threadId` and `status`
    // entirely; only `toolName` is honoured. Asked BEHAVIOURALLY rather than by
    // reading its source: an entry ninety days old, fetched under a thirty-day
    // window and a status that does not match, comes back anyway.
    const double = new InMemoryToolsRepository(tenant.scope);
    await double.appendAudit(tenant.scope, {
      toolCallAuditId: asToolsIdentifier("55555555-6666-4777-8888-999999999999"),
      environmentId: tenant.scope.environmentId,
      toolId: null,
      toolName: toolsName("zeta.old"),
      agentId: null,
      threadId: null,
      endUserId: null,
      traceId: null,
      arguments: { q: "old" },
      result: null,
      error: null,
      status: "SUCCEEDED",
      latencyMs: 12,
      costCents: null,
      envelope: EMPTY_ENVELOPE,
      createdAt: older,
    });
    const doubleWindowed = await double.pageAudit(tenant.scope, {
      sinceDays: 30,
      limit: 10,
      offset: 0,
      toolName: null,
      agentId: null,
      threadId: null,
      status: "FAILED",
    });
    expect(doubleWindowed.ok && doubleWindowed.value).toHaveLength(1);
  }, 120_000);
});

/** A double already holding one minted tool, so `replaceExposures` can find it. */
function doubleWithTool(
  scope: ToolsConformanceIds["scope"],
  toolId: ToolId,
): InMemoryToolsRepository {
  const double = new InMemoryToolsRepository(scope);
  double.seedTool({
    toolId,
    name: toolsName("gamma.read"),
    description: "read gamma",
    kind: "ENTITY",
    paramSchema: { type: "object" },
    category: "read",
    schemaHash: toolsSchemaHash("aaaabbbbccccdddd"),
    createdAt: TOOLS_AT,
    updatedAt: TOOLS_AT,
  });
  return double;
}
