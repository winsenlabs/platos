import { asIdentifier, type EntityId, type PrincipalId, type Result } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asToolsIdentifier,
  DEFAULT_MCP_RATE_LIMIT_PER_MINUTE,
  type AuditEntry,
  type ExternalEntityId,
  type OrganizationMcpPolicyId,
  type ToolCallAuditId,
  type ToolId,
  type ToolName,
} from "../domain/index.js";
import {
  MCP_TOOLS_PERMISSION,
  type PrincipalAuthorizationView,
} from "../application/authorization.js";
import {
  buildToolsTestContext,
  testExposure,
  testVaultAuthorization,
  type ToolsTestContext,
} from "../application/testing/index.js";
import { toolsContract, TOOLS_EVENT_NAMES, type ToolsContract } from "./index.js";

const ENTITY = asIdentifier<EntityId>("entity-pk-1");
const EXTERNAL = asToolsIdentifier<ExternalEntityId>("acme-backend");
const UPLOAD = asToolsIdentifier<ToolName>("files.upload");

let context: ToolsTestContext;
let contract: ToolsContract;

beforeEach(() => {
  context = buildToolsTestContext();
  contract = toolsContract(context.dependencies);
  context.tenancy.seedEntity(ENTITY, EXTERNAL);
  context.repository.seedExposure(testExposure(context.scope, { entityId: ENTITY }));
});

/** One audit row, complete, so a case names only the field it is about. */
function auditRow(id: string, overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    toolCallAuditId: asToolsIdentifier<ToolCallAuditId>(id),
    environmentId: context.scope.environmentId,
    toolId: asToolsIdentifier<ToolId>("tool-1"),
    toolName: UPLOAD,
    agentId: null,
    threadId: null,
    endUserId: null,
    traceId: null,
    arguments: {},
    result: null,
    error: null,
    status: "SUCCEEDED",
    latencyMs: 10,
    costCents: null,
    envelope: {
      externalEntityId: null,
      endUserId: null,
      actorUserId: null,
      spanId: null,
      parentSpanId: null,
      source: "turn",
      mcpPrincipalId: null,
      mcpClientId: null,
    },
    createdAt: context.clock.now(),
    ...overrides,
  };
}

describe("the published surface", () => {
  it("names itself, and is frozen so nothing can graft behaviour onto it", () => {
    expect(contract.name).toBe("tools");
    expect(Object.isFrozen(contract)).toBe(true);
  });

  it("returns Result from every method rather than throwing", async () => {
    const listed = await contract.listTools({ authorization: context.tenancy.grant() });
    expect(listed.ok).toBe(true);
    const refused = await contract.listTools({ authorization: { forged: true } });
    expect(refused.ok).toBe(false);
  });
});

describe("what the views withhold", () => {
  it("never publishes a callback URL", async () => {
    const listed = await contract.listTools({ authorization: context.tenancy.grant() });
    const [tool] = listed.ok ? listed.value : [];
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool)).not.toContain("acme.test");
    expect(Object.keys(tool ?? {})).not.toContain("callbackUrl");
  });

  it("never publishes a resolved header set, and offers no method that could", () => {
    const methods = Object.keys(contract);
    expect(methods.some((method) => /header|credential|secret/iu.test(method))).toBe(false);
  });

  it("never publishes an audit row's arguments or result", async () => {
    context.repository.audit.push(
      auditRow("audit-1", {
        arguments: { secretishQuestion: "what is my password" },
        result: { rows: ["private"] },
      }),
    );
    const listed = await contract.readToolAudit({ authorization: context.tenancy.grant() });
    const rendered = JSON.stringify(listed.ok ? listed.value : []);
    expect(rendered).not.toContain("what is my password");
    expect(rendered).not.toContain("private");
    expect(rendered).toContain("files.upload");
  });

  /**
   * THE ROWS ARE SEEDED AND THE ITERATION IS ASSERTED, BECAUSE THE EARLIER FORM
   * WAS VACUOUS TWICE OVER.
   *
   * It looped over `listed.ok ? listed.value : []` against a store this
   * `beforeEach` leaves EMPTY, so the body never ran; and it passed on a
   * refusal too, because a refusal also yields `[]`. Its assertion —
   * `costCents === null || typeof costCents === "string"` — was satisfied by
   * the LEFT disjunct in every reachable case, so a float would have been
   * admitted by a test whose title forbids one.
   *
   * `typeof … !== "number"` is the claim that actually refuses a float: it is
   * false for `1.5` and true for both a string and `null`, so it cannot be
   * satisfied by the absence of a cost. Money here is bigint micro-cents in a
   * `Decimal(18, 6)` column, and a float would silently lose the last places.
   */
  it("carries a cost as a canonical decimal STRING, never a number", async () => {
    context.repository.audit.push(auditRow("audit-priced", { costCents: "1234.567890" }));
    context.repository.audit.push(auditRow("audit-unpriced", { costCents: null }));

    const listed = await contract.readToolAudit({ authorization: context.tenancy.grant() });
    const entries = listed.ok ? listed.value : [];
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(typeof entry.costCents).not.toBe("number");
    }
    expect(entries.map((entry) => entry.costCents).sort()).toEqual([
      "1234.567890",
      null,
    ]);
  });
});

/**
 * THE OPERATOR GATE, ON EVERY PUBLISHED METHOD THAT HAS ONE.
 *
 * `verifyOperator` guards fourteen use cases and the guard is the same two
 * hand-written lines at each: ask tenancy, refuse if the answer is no. ELEVEN
 * OF THE FOURTEEN COULD HAVE THEIR GUARD DELETED WITH THE WHOLE SUITE GREEN —
 * `pageTools`, `findTools`, `setToolEnabled`, `describeMcpSurface`,
 * `configureMcpSurface`, `listEntityToolPolicies`, `setEntityToolPolicy`,
 * `listOrganizationPolicies`, `setOrganizationPolicy`,
 * `deleteOrganizationPolicy` and `discoverEntityTools`. Six of the eleven
 * MUTATE. Only `registerTools`, `readToolAudit` and `listTools` had a case that
 * noticed, which is what a guard copied fourteen times decays into: the copy is
 * cheap and the proof is not.
 *
 * IT IS DRIVEN OFF `Object.keys(contract)` RATHER THAN A HAND-KEPT LIST, so the
 * classification case below goes red when a method is ADDED to the published
 * surface and nobody says which gate it is behind. A per-method list would have
 * exactly the failure mode this suite exists to close: it would be complete on
 * the day it was written and silently partial thereafter.
 *
 * THE REFUSAL IS TESTED THROUGH THE CONTRACT, NOT THE USE CASE, because the
 * binder is between them. A binder that dropped the caller's authorization
 * would leave every use-case-level refusal passing and production open.
 *
 * EACH REFUSAL HAS ITS OWN POSITIVE CONTROL. A method that refused everything
 * would satisfy a refusal case for the wrong reason, so each is paired with the
 * same call under a grant tenancy DID mint, which must not fail for that
 * reason. It may still fail for its own — a surface not configured, a policy
 * row absent — and those are different refusals, named differently.
 */
describe("the operator gate, on every method that has one", () => {
  const FORGED = Object.freeze({ access: "secret:mutate", scope: { kind: "environment" } });

  const invocations: Readonly<
    Record<string, (authorization: unknown) => Promise<Result<unknown>>>
  > = {
    registerTools: (authorization) =>
      contract.registerTools({
        authorization,
        entityId: ENTITY,
        externalEntityId: EXTERNAL,
        tools: [{ name: "files.upload" }],
        callbackUrl: null,
      }),
    listTools: (authorization) => contract.listTools({ authorization }),
    pageTools: (authorization) => contract.pageTools({ authorization, limit: 10, offset: 0 }),
    setToolEnabled: (authorization) =>
      contract.setToolEnabled({ authorization, exposureId: "exposure-1", enabled: false }),
    findTools: (authorization) => contract.findTools({ authorization, query: "upload" }),
    discoverEntityTools: (authorization) =>
      contract.discoverEntityTools({
        authorization,
        entityId: ENTITY,
        externalEntityId: EXTERNAL,
        vaultAuthorization: testVaultAuthorization(),
      }),
    describeMcpSurface: (authorization) =>
      contract.describeMcpSurface({ authorization, entityId: ENTITY }),
    configureMcpSurface: (authorization) =>
      contract.configureMcpSurface({ authorization, entityId: ENTITY, enabled: true }),
    listEntityToolPolicies: (authorization) =>
      contract.listEntityToolPolicies({ authorization, entityId: ENTITY }),
    setEntityToolPolicy: (authorization) =>
      contract.setEntityToolPolicy({
        authorization,
        entityId: ENTITY,
        toolId: asToolsIdentifier<ToolId>("tool-1"),
        exposed: true,
      }),
    listOrganizationPolicies: (authorization) => contract.listOrganizationPolicies({ authorization }),
    setOrganizationPolicy: (authorization) =>
      contract.setOrganizationPolicy({ authorization, pattern: "gdpr.*", state: "block" }),
    deleteOrganizationPolicy: (authorization) =>
      contract.deleteOrganizationPolicy({
        authorization,
        organizationMcpPolicyId: asToolsIdentifier<OrganizationMcpPolicyId>("policy-1"),
      }),
    readToolAudit: (authorization) => contract.readToolAudit({ authorization }),
  };

  /**
   * The three methods that carry no operator grant, each for a stated reason.
   *
   * `listCallableForMcpCaller` is the hosted MCP surface and takes a THIRD
   * PARTY's bearer credential, verified by identity-access in
   * `application/tool-policy.test.ts`. `executeTool` and `resolvePermission`
   * are reached by a runtime that has already been authorized upstream and take
   * a scope rather than a grant. Naming them here is what makes their absence
   * from the table above a decision rather than an omission.
   */
  const credentialAuthorized = ["listCallableForMcpCaller", "executeTool", "resolvePermission"];

  it("classifies every published method, so a new one cannot arrive unclassified", () => {
    const published = Object.keys(contract).filter((method) => method !== "name");
    expect([...Object.keys(invocations), ...credentialAuthorized].sort()).toEqual(published.sort());
  });

  for (const [method, invoke] of Object.entries(invocations)) {
    it(`${method} refuses a grant tenancy did not mint`, async () => {
      const refused = await invoke(FORGED);
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.error.code).toBe("TOOLS_REPOSITORY_UNAVAILABLE");
      expect(!refused.ok && refused.error.details.reason).toBe("authorization_not_issued");
    });

    it(`${method} admits a grant tenancy did mint`, async () => {
      const answered = await invoke(context.tenancy.grant());
      const reason = answered.ok ? null : answered.error.details.reason;
      expect(reason).not.toBe("authorization_not_issued");
    });
  }
});

describe("what the surface deliberately exposes", () => {
  it("answers a permission question WITHOUT the side effect", async () => {
    const decided = await contract.resolvePermission({
      scope: context.scope,
      toolName: asToolsIdentifier<ToolName>("kg.delete_node"),
      agentId: null,
      toolId: null,
    });
    expect(decided.ok && decided.value.state).toBe("require_approval");
    expect(context.dispatch.requests).toEqual([]);
    expect(context.repository.audit).toEqual([]);
  });

  it("binds registration, discovery and execution through one dependency bundle", async () => {
    const registered = await contract.registerTools({
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      externalEntityId: EXTERNAL,
      tools: [{ name: "files.upload" }],
      callbackUrl: "https://acme.test/tools",
    });
    expect(registered.ok && registered.value.registered).toBe(1);
    expect(registered.ok && registered.value.tools[0]?.toolName).toBe("files.upload");

    const executed = await contract.executeTool({
      scope: context.scope,
      toolName: UPLOAD,
      arguments: {},
      agentId: null,
      threadId: null,
      endUserId: null,
      vaultAuthorization: testVaultAuthorization(),
    });
    expect(executed.ok && executed.value.kind).toBe("completed");
  });
});

// The hosted MCP surface, through the PUBLISHED contract rather than the use
// case. A transport binds this object and nothing else, so the gate is only
// real if it survives the binding: a binder that dropped `presentedToken` on
// the floor would leave every refusal below passing at the use-case level and
// failing in production.
describe("the hosted MCP surface, as a transport binds it", () => {
  const TOKEN = "mcp-pat-live";

  async function openSurface(): Promise<void> {
    await contract.setEntityToolPolicy({
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      exposed: true,
      scopeLabels: [],
    });
    await contract.configureMcpSurface({
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      enabled: true,
    });
    context.identityAccess.seed(TOKEN, {
      principalId: asIdentifier<PrincipalId>("mcp:pat:pat-1"),
      tier: "END_USER",
      credentialId: "cred-1",
      scope: { kind: "ENVIRONMENT", tenant: context.scope },
      permissions: [MCP_TOOLS_PERMISSION],
    } satisfies PrincipalAuthorizationView);
  }

  beforeEach(() => {
    context.repository.seedMcpConfig({
      entityId: ENTITY,
      enabled: false,
      identityMode: "bearer",
      identityProviders: [],
      branding: {},
      toolAllowlist: [],
      redirectUriAllowlist: [],
      rateLimitPerMinute: DEFAULT_MCP_RATE_LIMIT_PER_MINUTE,
      injectMcpContext: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  it("answers a credential-holding caller with the tools it may see", async () => {
    await openSurface();
    const listed = await contract.listCallableForMcpCaller({
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: TOKEN,
    });
    expect(listed.ok && listed.value.map((tool) => tool.toolName)).toEqual(["files.upload"]);
  });

  it("REFUSES the same request with no credential", async () => {
    await openSurface();
    const refused = await contract.listCallableForMcpCaller({
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: null,
    });
    expect(!refused.ok && refused.error.code).toBe("UNAUTHENTICATED");
  });

  it("REFUSES the same credential once an operator switches the surface off", async () => {
    await openSurface();
    await contract.configureMcpSurface({
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      enabled: false,
    });
    const refused = await contract.listCallableForMcpCaller({
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: TOKEN,
    });
    expect(!refused.ok && refused.error.code).toBe("TOOLS_MCP_DISABLED");
  });

  it("offers no way to describe a caller instead of holding their credential", () => {
    // The method takes ONE object and that object carries a token. There is no
    // overload, no optional identity argument and no field a transport could
    // fill in to assert who is calling — which is what makes "derived, never
    // asserted" a property of the boundary rather than of one implementation.
    expect(contract.listCallableForMcpCaller.length).toBe(1);
  });
});

describe("the integration events", () => {
  it("are dotted and led by the owning context, per the kernel envelope", () => {
    for (const name of TOOLS_EVENT_NAMES) {
      expect(name.startsWith("tools."), name).toBe(true);
      expect(name.split(".").length, name).toBeGreaterThanOrEqual(3);
    }
  });

  it("names each event once", () => {
    expect(new Set(TOOLS_EVENT_NAMES).size).toBe(TOOLS_EVENT_NAMES.length);
  });
});
