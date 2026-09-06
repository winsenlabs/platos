// What the REAL database said that the in-memory double does not.
//
// The double `packages/contexts/tools` ships enforces four store constraints on
// purpose and names them in its own header. Every case below is a constraint it
// does NOT have, and each one is either a rule that exists ONLY in the
// migrations — a CHECK, an ancestry rule, a NULL-distinct unique index — or a
// column that holds less than the record does. A use case that met any of them
// by accident passes against the double and fails on the first real write.
//
// THE MIGRATIONS ARE THE SOURCE, NOT `schema.prisma`. Four ancestry rules
// touch this context's rows and not one of them is expressible in the schema
// file: `EnvironmentEntityTool_ancestry`, `EntityToolPolicy_ancestry` (replaced
// by `enforce_m4_forward_upgrade_ancestry` in a later migration),
// `EntityMcpClient_ancestry` and `ToolCallAudit_ancestry`. All four fire on
// UPDATE as well as INSERT.
//
// Run by `pnpm test:postgres-tenancy:integration`. FAILS when Docker is absent.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  AuditEntry,
  EntityId,
  EntityMcpClient,
  EntityMcpConfig,
  EntityToolPolicy,
  EntityToolPolicyId,
  StepId,
  ToolCall,
  ToolCallAuditId,
  ToolCallId,
  ToolId,
  ToolName,
  SchemaHash,
  ActorId,
} from "@platos/context-tools/application/ports/index.js";
import {
  asToolsIdentifier,
  EMPTY_AUDIT_ENVELOPE,
} from "@platos/context-tools/application/ports/index.js";

import { TOOLS_AT } from "./tools-conformance.js";
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

/** A fresh sixteen-hex fingerprint, so no two cases share a `Tool` row. */
function freshHash(): SchemaHash {
  sequence += 1;
  return toolsSchemaHash(sequence.toString(16).padStart(16, "0"));
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
function reason(result: { readonly ok: boolean; readonly error?: { details: Record<string, unknown> } }): unknown {
  return result.ok ? "<accepted>" : (result.error?.details.reason ?? null);
}

describe("constraints that exist only in the migrations", () => {
  test("EnvironmentEntityTool_ancestry refuses an entity from another project", async () => {
    const toolId = await mintTool("ancestry.exposure");
    const refused = await harness.repository.replaceExposures({
      scope: tenant.scope,
      // The entity is REAL and the scope is REAL; they belong to different
      // projects. Nothing in `schema.prisma` says so and the double cannot.
      entityId: toolsEntityId(other.wireEntityId),
      callbackUrl: "https://backend.example.test/hooks",
      toolIds: [toolId],
    });
    expect(refused.ok).toBe(false);
    expect(String(reason(refused))).toContain("replaceExposures:");
  }, 120_000);

  test("EntityToolPolicy_ancestry refuses the same crossing on a policy", async () => {
    const toolId = await mintTool("ancestry.policy");
    const policy: EntityToolPolicy = {
      entityToolPolicyId: asToolsIdentifier<EntityToolPolicyId>("<minted>"),
      environmentId: tenant.scope.environmentId,
      entityId: toolsEntityId(other.wireEntityId),
      toolId,
      toolName: toolsName("ancestry.policy"),
      effect: "ALLOW",
      minIdentityMode: "anonymous",
      scopeLabels: [],
      allowedPatIds: [],
      addedBy: asToolsIdentifier<ActorId>("system"),
      addedAt: TOOLS_AT,
      lastReviewedAt: null,
    };
    const refused = await harness.repository.upsertEntityToolPolicy(policy);
    expect(refused.ok).toBe(false);
    expect(String(reason(refused))).toContain("upsertEntityToolPolicy:");
  }, 120_000);

  test("EntityMcpClient_ancestry refuses a credential from another project", async () => {
    const client: EntityMcpClient = {
      entityId: toolsEntityId(tenant.mcpEntityId),
      transport: "http",
      url: "https://mcp.example.test",
      // The OTHER tenant's credential. The rule joins the credential's
      // environment to its project and compares that to the entity's project.
      credentialId: toolsCredentialId(other.credentialId),
      credentialName: toolsCredentialName(other.credentialName),
      headersTemplate: {},
      lastDiscoveryAt: null,
      discoveryError: null,
      createdAt: TOOLS_AT,
      updatedAt: TOOLS_AT,
    };
    const refused = await harness.repository.saveMcpClient(tenant.scope, client);
    expect(refused.ok).toBe(false);
    expect(String(reason(refused))).toContain("saveMcpClient:");
  }, 120_000);

  test("the json-root CHECK refuses a scalar result and this adapter navigates it", async () => {
    const toolId = await mintTool("scalar.result");
    const stepId = await harness.seedStep(tenant, 20);
    const call: ToolCall = {
      toolCallId: asToolsIdentifier<ToolCallId>("66666666-1111-4111-8111-111111111111"),
      stepId: asToolsIdentifier<StepId>(stepId),
      toolId,
      sequence: 1,
      toolName: toolsName("scalar.result"),
      arguments: { q: 1 },
      result: "a bare string",
      status: "SUCCEEDED",
      retryCount: 0,
      error: null,
      latencyMs: 5,
      startedAt: null,
      completedAt: null,
      createdAt: TOOLS_AT,
    };
    const saved = await harness.repository.saveCall(tenant.scope, call);
    expect(saved.ok && saved.value.result).toBe("a bare string");

    // And the constraint really is there: the same value written straight into
    // the column, bypassing the wrapper, is refused by PostgreSQL.
    await expect(
      harness.onlooker.$executeRaw`
        UPDATE "public"."ToolCall"
        SET "result" = '"a bare string"'::jsonb
        WHERE "id" = '66666666-1111-4111-8111-111111111111'::uuid`,
    ).rejects.toThrow();
  }, 120_000);

  test("ToolCall_stepId_sequence_key refuses a second call at one sequence", async () => {
    const toolId = await mintTool("sequence.clash");
    const stepId = await harness.seedStep(tenant, 21);
    const base: ToolCall = {
      toolCallId: asToolsIdentifier<ToolCallId>("66666666-2222-4222-8222-222222222221"),
      stepId: asToolsIdentifier<StepId>(stepId),
      toolId,
      sequence: 7,
      toolName: toolsName("sequence.clash"),
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
    expect(reason(await harness.repository.saveCall(tenant.scope, base))).toBe("<accepted>");
    const clash = await harness.repository.saveCall(tenant.scope, {
      ...base,
      toolCallId: asToolsIdentifier<ToolCallId>("66666666-2222-4222-8222-222222222222"),
    });
    expect(clash.ok).toBe(false);
    expect(String(reason(clash))).toBe("saveCall:P2002");
  }, 120_000);

  test("a step in another environment is refused, and it is not the same refusal", async () => {
    const toolId = await mintTool("foreign.step");
    const refused = await harness.repository.saveCall(tenant.scope, {
      toolCallId: asToolsIdentifier<ToolCallId>("66666666-3333-4333-8333-333333333333"),
      // The OTHER tenant's step, under this tenant's scope. `ToolCall` has no
      // tenant column at all: its ancestry is Step -> Turn -> Thread.
      stepId: asToolsIdentifier<StepId>(other.stepId),
      toolId,
      sequence: 1,
      toolName: toolsName("foreign.step"),
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
    expect(refused.ok).toBe(false);
    expect(reason(refused)).toBe("step_out_of_scope:saveCall");
  }, 120_000);

  test("two concurrent mints of one fingerprint produce ONE row", async () => {
    const upsert = {
      name: toolsName("racing.mint"),
      description: "raced",
      paramSchema: { type: "object" },
      category: "test",
      schemaHash: freshHash(),
    };
    const [left, right] = await Promise.all([
      harness.repository.upsertTool(upsert),
      harness.repository.upsertTool(upsert),
    ]);
    expect(left.ok && right.ok).toBe(true);
    // The unique index is what makes this true; the loser is answered from the
    // row that won rather than raising, which is the whole point of the catch.
    expect(left.ok && right.ok && left.value.toolId).toBe(right.ok ? right.value.toolId : null);
    const rows = await harness.onlooker.tool.count({ where: { name: "racing.mint" } });
    expect(rows).toBe(1);
  }, 120_000);
});

describe("columns that hold less than the record does", () => {
  test("a NULL Tool.category reads back as the empty string", async () => {
    // Written in SQL because the adapter always supplies a category, and the
    // rows this has to tolerate were written before the registry inferred one.
    await harness.onlooker.$executeRaw`
      INSERT INTO "public"."Tool" ("id", "name", "description", "kind", "paramSchema", "category", "schemaHash", "createdAt", "updatedAt")
      VALUES (
        '77777777-1111-4111-8111-111111111111'::uuid,
        'legacy.uncategorised',
        'written before categories',
        'ENTITY'::"ToolKind",
        '{"type":"object"}'::jsonb,
        NULL,
        'cafecafecafecafe',
        now(),
        now()
      )`;
    const found = await harness.repository.findToolByFingerprint(
      toolsName("legacy.uncategorised"),
      toolsSchemaHash("cafecafecafecafe"),
    );
    expect(found.ok && found.value?.category).toBe("");
  }, 120_000);

  test("the audit envelope survives seven fields having no column", async () => {
    const toolId = await mintTool("envelope.round");
    const entry: AuditEntry = {
      toolCallAuditId: asToolsIdentifier<ToolCallAuditId>("88888888-1111-4111-8111-111111111111"),
      environmentId: tenant.scope.environmentId,
      toolId,
      toolName: toolsName("envelope.round"),
      agentId: toolsAgentId(tenant.agentId),
      threadId: toolsThreadId(tenant.threadId),
      endUserId: toolsEndUserId(tenant.endUserId),
      traceId: "trace-envelope",
      arguments: { body: "sealed" },
      result: { rows: 2 },
      error: null,
      status: "SUCCEEDED",
      latencyMs: 9,
      costCents: "0.25",
      envelope: {
        externalEntityId: toolsExternalId("acme"),
        endUserId: toolsEndUserId(tenant.endUserId),
        actorUserId: toolsActorId("operator-7"),
        spanId: "span-7",
        parentSpanId: "span-6",
        source: "mcp",
        mcpPrincipalId: "mcp:pat:7",
        mcpClientId: "client-7",
      },
      createdAt: new Date(),
    };
    const appended = await harness.repository.appendAudit(tenant.scope, entry);
    expect(appended.ok && appended.value.envelope).toEqual(entry.envelope);

    // The layout is the SOURCE's, not one this adapter invented: the shipping
    // writer keys the envelope `__platosAudit` and the arguments `value`, and a
    // row this adapter wrote has to be readable by it.
    const row = await harness.onlooker.toolCallAudit.findUniqueOrThrow({
      where: { id: entry.toolCallAuditId },
      select: { arguments: true },
    });
    const stored = row.arguments as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["__platosAudit", "value"]);
    expect((stored.__platosAudit as Record<string, unknown>).mcpUserId).toBe("mcp:pat:7");
    expect((stored.__platosAudit as Record<string, unknown>).entityId).toBe("acme");
  }, 120_000);

  test("a pre-envelope audit row reads back whole, with an empty envelope", async () => {
    const createdAt = new Date();
    await harness.seedLegacyAudit({
      environmentId: other.scope.environmentId,
      toolName: "legacy.audit",
      argumentsValue: { q: "unsealed" },
      createdAt,
    });
    const page = await harness.repository.pageAudit(other.scope, {
      sinceDays: 30,
      limit: 10,
      offset: 0,
      toolName: toolsName("legacy.audit"),
      agentId: null,
      threadId: null,
      status: null,
    });
    expect(page.ok && page.value).toHaveLength(1);
    const entry = page.ok ? page.value[0] : undefined;
    // The whole column IS the arguments, and the envelope is empty rather than
    // half-read. Expand/contract: this binary reads rows written without the
    // newer layout.
    expect(entry?.arguments).toEqual({ q: "unsealed" });
    expect(entry?.envelope).toEqual(EMPTY_AUDIT_ENVELOPE);
  }, 120_000);

  test("credentialName is read from the credential and never from the caller", async () => {
    const client: EntityMcpClient = {
      entityId: toolsEntityId(tenant.mcpEntityId),
      transport: "http",
      url: "https://mcp.example.test",
      credentialId: toolsCredentialId(tenant.credentialId),
      // A LIE. There is no column to hold it, so the store discards it.
      credentialName: toolsCredentialName("NOT_THE_REAL_NAME"),
      headersTemplate: {},
      lastDiscoveryAt: null,
      discoveryError: null,
      createdAt: TOOLS_AT,
      updatedAt: TOOLS_AT,
    };
    const saved = await harness.repository.saveMcpClient(tenant.scope, client);
    expect(saved.ok && saved.value.credentialName).toBe(tenant.credentialName);
    // And the default template appears, because a credential IS named — the
    // domain rule, applied to the joined name rather than the raw column.
    expect(saved.ok && saved.value.headersTemplate).toEqual({
      Authorization: "Bearer {{secret}}",
    });
  }, 120_000);

  test("an identity provider this binary does not know is dropped, not refused", async () => {
    const config: EntityMcpConfig = {
      entityId: toolsEntityId(other.mcpEntityId),
      enabled: true,
      identityMode: "oidc",
      identityProviders: [{ kind: "oidc", issuer: "https://idp.example.test", audience: "a" }],
      branding: {},
      toolAllowlist: [],
      redirectUriAllowlist: [],
      rateLimitPerMinute: 60,
      injectMcpContext: false,
      createdAt: TOOLS_AT,
      updatedAt: TOOLS_AT,
    };
    expect((await harness.repository.saveMcpConfig(other.scope, config)).ok).toBe(true);
    await harness.onlooker.$executeRaw`
      UPDATE "public"."EntityMcpConfig"
      SET "identityProviders" = '[{"kind":"saml"},{"kind":"oidc","issuer":"https://idp.example.test","audience":"a"}]'::jsonb
      WHERE "entityId" = ${other.mcpEntityId}::uuid`;
    const read = await harness.repository.findMcpConfig(
      other.scope,
      toolsEntityId(other.mcpEntityId),
    );
    // One unknown descriptor must not make the whole hosted surface unreadable.
    expect(read.ok && read.value?.identityProviders).toEqual([
      { kind: "oidc", issuer: "https://idp.example.test", audience: "a" },
    ]);
  }, 120_000);
});
