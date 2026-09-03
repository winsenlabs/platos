import { asIdentifier, type EntityId, type PrincipalId } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asToolsIdentifier,
  DEFAULT_MCP_RATE_LIMIT_PER_MINUTE,
  type ExternalEntityId,
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
    context.repository.audit.push({
      toolCallAuditId: asToolsIdentifier("audit-1"),
      environmentId: context.scope.environmentId,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      toolName: UPLOAD,
      agentId: null,
      threadId: null,
      endUserId: null,
      traceId: null,
      arguments: { secretishQuestion: "what is my password" },
      result: { rows: ["private"] },
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
    });
    const listed = await contract.readToolAudit({ authorization: context.tenancy.grant() });
    const rendered = JSON.stringify(listed.ok ? listed.value : []);
    expect(rendered).not.toContain("what is my password");
    expect(rendered).not.toContain("private");
    expect(rendered).toContain("files.upload");
  });

  it("carries a cost as a canonical decimal STRING, never a number", async () => {
    const listed = await contract.readToolAudit({ authorization: context.tenancy.grant() });
    for (const entry of listed.ok ? listed.value : []) {
      expect(entry.costCents === null || typeof entry.costCents === "string").toBe(true);
    }
  });
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
