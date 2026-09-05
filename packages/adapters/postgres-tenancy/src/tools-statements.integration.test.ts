// Statement counts for the tools store, MEASURED — the N+1 control.
//
// Every pin below is a number this suite observed rather than a number somebody
// expected, and every one that can grow is taken TWICE: once over a small
// fixture and once over one an order of magnitude larger. What matters is not
// the figure but that the figure does not move with the number of rows. An N+1
// does not announce itself in a suite — every value is correct and every test
// passes — it announces itself as a tool list that took four seconds because the
// entity declared two hundred tools.
//
// THIS PORT IS WHERE THAT MATTERS MOST. A resolved `ToolExposure` carries five
// things that are not on its own row: the tool, the entity's external id and
// connection kind, whether an MCP client row exists, whether the MCP config
// injects context, and the fold of the environment's whole agent-binding set
// into `allowedAgentIds`. Every one of those is a plausible per-row read, and
// `listExposures` is on the hot path of every turn.
//
// THE HEALTH-CHECK FILTER IS ANCHORED WHOLE. The sibling suites drop anything
// beginning `SELECT 1`, which is the driver's connection probe — and tranche 3
// found that is also the shape a lock statement naturally takes, so a lock was
// measured at ZERO. Nothing here projects a bare constant, and the filter
// anchors both ends so it cannot eat a statement it was not written for.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  AuditEntry,
  EntityId,
  ToolCallAuditId,
  ToolId,
  ToolName,
  SchemaHash,
} from "@platos/context-tools/application/ports/index.js";
import { asToolsIdentifier } from "@platos/context-tools/application/ports/index.js";

import type { SeededToolsTenant, ToolsHarness } from "./tools-harness.js";
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
/** Two tools on one entity. */
let light: SeededToolsTenant;
/** Twenty tools on one entity, so a per-row cost would show. */
let heavy: SeededToolsTenant;
let sequence = 0;

const LIGHT_TOOLS = 2;
const HEAVY_TOOLS = 20;
const HEAVY_AUDIT_ROWS = 30;

function queries(): readonly string[] {
  return harness
    .statements()
    .filter(
      (statement) =>
        !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)\b/iu.test(statement) &&
        !/^\s*SELECT 1\s*$/iu.test(statement),
    );
}

async function measure(work: () => Promise<unknown>): Promise<number> {
  harness.resetStatements();
  await work();
  return queries().length;
}

async function mintTools(count: number, prefix: string): Promise<readonly ToolId[]> {
  const minted: ToolId[] = [];
  for (let index = 0; index < count; index += 1) {
    sequence += 1;
    const result = await harness.repository.upsertTool({
      name: toolsName(`${prefix}.tool${String(index)}`),
      description: "measured",
      paramSchema: { type: "object" },
      category: "test",
      schemaHash: toolsSchemaHash(sequence.toString(16).padStart(16, "0")),
    });
    if (!result.ok) throw new Error(`mint failed: ${result.error.code}`);
    minted.push(result.value.toolId);
  }
  return minted;
}

async function register(tenant: SeededToolsTenant, toolIds: readonly ToolId[]): Promise<void> {
  const written = await harness.repository.replaceExposures({
    scope: tenant.scope,
    entityId: toolsEntityId(tenant.wireEntityId),
    callbackUrl: "https://backend.example.test/hooks",
    toolIds,
  });
  if (!written.ok) throw new Error(`registration failed: ${written.error.code}`);
}

beforeAll(async () => {
  harness = await startToolsHarness();
  light = await harness.seedToolsTenant("statements-light");
  heavy = await harness.seedToolsTenant("statements-heavy");
  await register(light, await mintTools(LIGHT_TOOLS, "light"));
  await register(heavy, await mintTools(HEAVY_TOOLS, "heavy"));

  for (let index = 0; index < HEAVY_AUDIT_ROWS; index += 1) {
    const entry: AuditEntry = {
      toolCallAuditId: asToolsIdentifier<ToolCallAuditId>(
        `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ),
      environmentId: heavy.scope.environmentId,
      toolId: null,
      toolName: toolsName("measured.audit"),
      agentId: null,
      threadId: null,
      endUserId: null,
      traceId: null,
      arguments: { index },
      result: null,
      error: null,
      status: "SUCCEEDED",
      latencyMs: 1,
      costCents: null,
      envelope: {
        externalEntityId: null,
        endUserId: null,
        actorUserId: null,
        spanId: null,
        parentSpanId: null,
        source: null,
        mcpPrincipalId: null,
        mcpClientId: null,
      },
      createdAt: new Date(),
    };
    const appended = await harness.repository.appendAudit(heavy.scope, entry);
    if (!appended.ok) throw new Error(`audit seed failed: ${appended.error.code}`);
  }
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

describe("statement counts", () => {
  test("the whole exposure matrix costs the same for 2 tools and for 20", async () => {
    const small = await measure(() => harness.repository.listExposures(light.scope));
    const large = await measure(() => harness.repository.listExposures(heavy.scope));
    // SIX: the scope resolve, the agent bindings, the version, the version's
    // tool policies, the exposure rows, and the tool/entity relation loads the
    // client batches across every row rather than per row.
    expect(small).toBe(large);
    expect(small).toBeLessThanOrEqual(8);
    // Non-vacuity: the large fixture really is ten times the small one, so the
    // equality above is a property and not an empty set compared with itself.
    const largeRows = await harness.repository.listExposures(heavy.scope);
    const smallRows = await harness.repository.listExposures(light.scope);
    expect(largeRows.ok && largeRows.value).toHaveLength(HEAVY_TOOLS);
    expect(smallRows.ok && smallRows.value).toHaveLength(LIGHT_TOOLS);
  }, 120_000);

  test("a page costs the same whether it is drawn from 2 rows or from 20", async () => {
    const query = { limit: 5, offset: 0, entityId: null, search: null };
    const small = await measure(() => harness.repository.pageExposures(light.scope, query));
    const large = await measure(() => harness.repository.pageExposures(heavy.scope, query));
    expect(small).toBe(large);
    const page = await harness.repository.pageExposures(heavy.scope, query);
    // The page is CLAMPED and the total is not: a count taken under the page's
    // own window would report five and hide fifteen rows from the caller.
    expect(page.ok && page.value.items).toHaveLength(5);
    expect(page.ok && page.value.total).toBe(HEAVY_TOOLS);
  }, 120_000);

  test("registering 20 tools costs the same as registering 2", async () => {
    const smallTools = await mintTools(LIGHT_TOOLS, "reg-light");
    const largeTools = await mintTools(HEAVY_TOOLS, "reg-heavy");
    const small = await measure(() => register(light, smallTools));
    const large = await measure(() => register(heavy, largeTools));
    // THE WRITE-SIDE N+1. An upsert per declared tool would make this linear,
    // and no assertion on the returned exposures could see it: every value
    // would still be right. Three set statements plus the read-back.
    expect(small).toBe(large);
  }, 180_000);

  test("the audit page costs the same over 0 rows and over 30", async () => {
    const query = {
      sinceDays: 3_650,
      limit: 10,
      offset: 0,
      toolName: null,
      agentId: null,
      threadId: null,
      status: null,
    };
    const empty = await measure(() => harness.repository.pageAudit(light.scope, query));
    const full = await measure(() => harness.repository.pageAudit(heavy.scope, query));
    expect(empty).toBe(full);
    // Two: the scope resolve and the page itself.
    expect(full).toBe(2);
    const rows = await harness.repository.pageAudit(heavy.scope, query);
    expect(rows.ok && rows.value).toHaveLength(10);
  }, 120_000);

  test("the bindings read costs the same for one binding as for six", async () => {
    const one = await measure(() => harness.repository.listAgentPolicyBindings(light.scope));
    for (let index = 0; index < 5; index += 1) {
      await harness.seedToolsTenant(`bindings-${String(index)}`);
    }
    const many = await measure(() => harness.repository.listAgentPolicyBindings(heavy.scope));
    expect(one).toBe(many);
  }, 300_000);

  test("the single-row reads and writes cost what they say they cost", async () => {
    const entityId = toolsEntityId(light.mcpEntityId);
    const config = await measure(() => harness.repository.findMcpConfig(light.scope, entityId));
    const client = await measure(() => harness.repository.findMcpClient(light.scope, entityId));
    const [someTool] = await mintTools(1, "single-read");
    const healthMiss = await measure(() =>
      harness.repository.findHealth(light.scope, someTool as ToolId, null),
    );
    // Two each: the scope resolve, then the row. A read that fell back to a
    // second lookup on a miss would be a cost paid exactly when a caller is
    // probing for rows that do not exist — which is what `foldHealth` does on
    // the first call to every tool.
    expect({ config, client, healthMiss }).toEqual({ config: 2, client: 2, healthMiss: 2 });
  }, 120_000);

  test("appending an audit row costs two statements, not more", async () => {
    const cost = await measure(() =>
      harness.repository.appendAudit(light.scope, {
        toolCallAuditId: asToolsIdentifier<ToolCallAuditId>(
          "cccccccc-0000-4000-8000-000000000001",
        ),
        environmentId: light.scope.environmentId,
        toolId: null,
        toolName: toolsName("measured.append"),
        agentId: null,
        threadId: null,
        endUserId: null,
        traceId: null,
        arguments: {},
        result: null,
        error: null,
        status: "SUCCEEDED",
        latencyMs: 1,
        costCents: null,
        envelope: {
          externalEntityId: null,
          endUserId: null,
          actorUserId: null,
          spanId: null,
          parentSpanId: null,
          source: null,
          mcpPrincipalId: null,
          mcpClientId: null,
        },
        createdAt: new Date(),
      }),
    );
    // The scope resolve and the INSERT. An audit write is on the hot path of
    // every dispatch, so a third statement here is a third statement per tool
    // call in production.
    expect(cost).toBe(2);
  }, 120_000);
});
