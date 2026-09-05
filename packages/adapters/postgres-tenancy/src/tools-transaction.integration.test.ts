// The transaction boundary, proved by FAILURE INJECTION against a real database.
//
// THE TRAP THIS SUITE EXISTS TO CLOSE IS NOT HYPOTHETICAL AND IT SHIPPED.
// `cost-monitoring` demonstrated that a store method which returns an error
// `Result` can still COMMIT the writes it made before the failure: the caller
// sees a refusal, the rows are there, and every test is green because the only
// thing that can tell the difference is a connection that was not the writer.
// Every case below therefore asserts BOTH halves — the call refused, AND the
// rows are as they were — and reads them back through `harness.onlooker`, a
// second client over the same database. Reading through the writer's own client
// would prove nothing at all inside a transaction, because a session sees its
// own uncommitted rows.
//
// `replaceExposures` IS THE ONE WORTH INJECTING INTO. It is three statements —
// a DELETE of what the entity no longer declares, an UPDATE of what it still
// does, and a CREATE of what it now adds — and the port's contract is "One
// transaction, or none." A store that ran them outside one would, on a
// declaration naming one tool that does not exist, delete a live tool's exposure
// and leave the entity with fewer tools than it started with.
//
// THE JOIN IS THE OTHER HALF. `ToolsRepository` takes no `TransactionScope` on
// any method, so every write here opens its own through `transactions.atomic`.
// That is only correct if `atomic` JOINS an already-open unit of work rather
// than opening a second transaction — otherwise a use case that composed a tools
// write with a tenancy write would get two transactions and a window between
// them, which is the arrangement ADR M0.3 §15 exists to refuse.
//
// Run by `pnpm test:postgres-tenancy:integration`. FAILS when Docker is absent.

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

import { slugOf } from "./harness.js";
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
let tenant: SeededToolsTenant;
let sequence = 0;

/** A `Tool` id that no row carries. The foreign key refuses it. */
const ABSENT_TOOL = asToolsIdentifier<ToolId>("99999999-9999-4999-8999-999999999999");

beforeAll(async () => {
  harness = await startToolsHarness();
  tenant = harness.first;
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

async function mintTool(name: string): Promise<ToolId> {
  sequence += 1;
  const minted = await harness.repository.upsertTool({
    name: toolsName(name),
    description: `the ${name} tool`,
    paramSchema: { type: "object" },
    category: "test",
    schemaHash: toolsSchemaHash(sequence.toString(16).padStart(16, "0")),
  });
  if (!minted.ok) throw new Error(`could not mint ${name}: ${minted.error.code}`);
  return minted.value.toolId;
}

/** Every `EnvironmentEntityTool` this tenant holds, read by somebody else. */
async function durableToolIds(): Promise<readonly string[]> {
  const rows = await harness.durableExposures(tenant.scope.environmentId);
  return rows.map((row) => row.toolId).sort();
}

describe("the transaction boundary, proved by failure injection", () => {
  test("when the CREATE of replaceExposures fails, the DELETE it already made is gone too", async () => {
    const alpha = await mintTool("txn.alpha");
    const beta = await mintTool("txn.beta");
    const entityId = toolsEntityId(tenant.wireEntityId);

    const registered = await harness.repository.replaceExposures({
      scope: tenant.scope,
      entityId,
      callbackUrl: "https://backend.example.test/hooks",
      toolIds: [alpha, beta],
    });
    expect(registered.ok).toBe(true);
    const before = await durableToolIds();
    expect(before).toEqual([alpha, beta].sort());

    // THE INJECTION. The declaration drops `beta` and adds a tool that does not
    // exist. The DELETE removes beta's exposure, the UPDATE touches alpha's, and
    // the CREATE then fails on `EnvironmentEntityTool_toolId_fkey`.
    const refused = await harness.repository.replaceExposures({
      scope: tenant.scope,
      entityId,
      callbackUrl: "https://backend.example.test/hooks",
      toolIds: [alpha, ABSENT_TOOL],
    });
    expect(refused.ok).toBe(false);
    // THE NON-VACUITY CONTROL, and it is not decoration. If the method had
    // refused BEFORE the delete — on the scope, on a validation error, on
    // anything — the rows would also be unchanged and the case below would pass
    // over an injection that never happened. `P2003` is the foreign key, which
    // only the CREATE can raise, so reaching it proves the DELETE already ran.
    expect(refused.ok ? null : refused.error.details.reason).toBe("replaceExposures:P2003");

    // BOTH HALVES. The refusal is not the test; the rows are. `beta` was deleted
    // inside the transaction and must be back, because the transaction is gone.
    const after = await durableToolIds();
    expect(after).toEqual(before);
  }, 120_000);

  test("a tools write inside an outer unit of work JOINS it and dies with it", async () => {
    const gamma = await mintTool("txn.gamma");
    const entityId = toolsEntityId(harness.second.wireEntityId);
    const before = await harness.durableExposures(harness.second.scope.environmentId);

    await expect(
      harness.adapter.unitOfWork.run(async () => {
        const written = await harness.repository.replaceExposures({
          scope: harness.second.scope,
          entityId,
          callbackUrl: "https://backend.example.test/hooks",
          toolIds: [gamma],
        });
        expect(written.ok).toBe(true);
        // The outer transaction fails AFTER the tools write. If `atomic` had
        // opened a second transaction, the exposure would already be committed
        // and this rollback could not reach it.
        throw new Error("the outer unit of work fails");
      }),
    ).rejects.toThrow("the outer unit of work fails");

    const after = await harness.durableExposures(harness.second.scope.environmentId);
    expect(after).toEqual(before);
  }, 120_000);

  test("a tools write and a tenancy write in one unit of work roll back together", async () => {
    // ADR M0.3 §15's argument, executable. Two contexts, one adapter directory,
    // one client — so ONE transaction. Two adapter packages would have been two
    // pools and a window in which one half is committed.
    const delta = await mintTool("txn.delta");
    const environmentId = harness.second.scope.environmentId;
    const slug = `txn-rollback-${String(Date.now())}`;

    await expect(
      harness.adapter.unitOfWork.run(async (transaction) => {
        await harness.adapter.saveOrganization(
          {
            id: asToolsIdentifier("aaaaaaaa-1111-4111-8111-111111111111"),
            slug: slugOf(slug),
            name: slug,
            archivedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          } as never,
          transaction,
        );
        const written = await harness.repository.replaceExposures({
          scope: harness.second.scope,
          entityId: toolsEntityId(harness.second.mcpEntityId),
          callbackUrl: null,
          toolIds: [delta],
        });
        expect(written.ok).toBe(true);
        throw new Error("the composed unit of work fails");
      }),
    ).rejects.toThrow("the composed unit of work fails");

    const organizations = await harness.onlooker.organization.count({ where: { slug } });
    const exposures = await harness.onlooker.environmentEntityTool.count({
      where: { environmentId, toolId: delta },
    });
    // NEITHER row survives. One of them belongs to `tenancy` and the other to
    // `tools`, and they went down together.
    expect({ organizations, exposures }).toEqual({ organizations: 0, exposures: 0 });
  }, 120_000);

  test("an audit row appended inside a rolled-back transaction does not survive", async () => {
    const epsilon = await mintTool("txn.epsilon");
    const auditId = asToolsIdentifier<ToolCallAuditId>("aaaaaaaa-2222-4222-8222-222222222222");
    const entry: AuditEntry = {
      toolCallAuditId: auditId,
      environmentId: tenant.scope.environmentId,
      toolId: epsilon,
      toolName: toolsName("txn.epsilon"),
      agentId: null,
      threadId: null,
      endUserId: null,
      traceId: null,
      arguments: { q: "rolled back" },
      result: null,
      error: null,
      status: "SUCCEEDED",
      latencyMs: 3,
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

    await expect(
      harness.adapter.unitOfWork.run(async () => {
        const appended = await harness.repository.appendAudit(tenant.scope, entry);
        expect(appended.ok).toBe(true);
        throw new Error("the audit transaction fails");
      }),
    ).rejects.toThrow("the audit transaction fails");

    // This is the exact defect `conversations` shipped: an event appended inside
    // a rolled-back transaction survived, because its double sat outside the
    // unit of work's snapshot set. Read by the ONLOOKER, so a session seeing its
    // own uncommitted rows cannot answer for the database.
    const surviving = await harness.onlooker.toolCallAudit.count({ where: { id: auditId } });
    expect(surviving).toBe(0);
  }, 120_000);

  test("a refused write commits NOTHING, which is the cost-monitoring trap", async () => {
    // The narrowest form of the trap: `saveMcpClient` resolves the entity, then
    // writes. The write is refused by the ancestry rule. If the refusal were
    // reported from outside a transaction — or if a partial write had escaped —
    // a row would be here.
    const before = await harness.onlooker.entityMcpClient.count({
      where: { entityId: harness.second.mcpEntityId },
    });
    const refused = await harness.repository.saveMcpClient(harness.second.scope, {
      entityId: toolsEntityId(harness.second.mcpEntityId),
      transport: "http",
      url: "https://mcp.example.test",
      credentialId: toolsCredentialId(tenant.credentialId),
      credentialName: toolsCredentialName(tenant.credentialName),
      headersTemplate: {},
      lastDiscoveryAt: null,
      discoveryError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(refused.ok).toBe(false);
    const after = await harness.onlooker.entityMcpClient.count({
      where: { entityId: harness.second.mcpEntityId },
    });
    expect(after).toBe(before);
  }, 120_000);
});
