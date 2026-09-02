import { asIdentifier, type EntityId } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asToolsIdentifier,
  DEFAULT_MCP_RATE_LIMIT_PER_MINUTE,
  type EntityMcpConfig,
  type ExposureId,
  type ExternalEntityId,
  type McpCaller,
  type ToolId,
  type ToolName,
} from "../domain/index.js";
import {
  listCallableForMcpCaller,
  listEntityToolPolicies,
  setEntityToolPolicy,
} from "./entity-tool-policy.js";
import { describeMcpSurface } from "./mcp-surface.js";
import { buildToolsTestContext, testExposure, type ToolsTestContext } from "./testing/index.js";

const ENTITY = asIdentifier<EntityId>("entity-pk-1");
const EXTERNAL = asToolsIdentifier<ExternalEntityId>("acme-backend");
const AT = new Date("2026-01-01T00:00:00.000Z");

let context: ToolsTestContext;

function config(overrides: Partial<EntityMcpConfig> = {}): EntityMcpConfig {
  return {
    entityId: ENTITY,
    enabled: false,
    identityMode: "bearer",
    identityProviders: [],
    branding: {},
    toolAllowlist: [],
    redirectUriAllowlist: [],
    rateLimitPerMinute: DEFAULT_MCP_RATE_LIMIT_PER_MINUTE,
    injectMcpContext: false,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

beforeEach(() => {
  context = buildToolsTestContext();
  context.tenancy.seedEntity(ENTITY, EXTERNAL);
  context.repository.seedExposure(testExposure(context.scope, { entityId: ENTITY }));
  context.repository.seedExposure(
    testExposure(context.scope, {
      entityId: ENTITY,
      exposureId: asToolsIdentifier<ExposureId>("exposure-2"),
      toolId: asToolsIdentifier<ToolId>("tool-2"),
      toolName: asToolsIdentifier<ToolName>("files.delete"),
    }),
  );
  context.repository.seedMcpConfig(config());
});
describe("the entity tool policy listing", () => {
  it("COMPLETES the listing with synthetic denials, so a fresh entity is configurable", async () => {
    const listed = await listEntityToolPolicies(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
    });
    expect(listed.ok && listed.value).toHaveLength(2);
    expect(listed.ok && listed.value.every((policy) => policy.effect === "DENY")).toBe(true);
    expect(listed.ok && listed.value.every((policy) => policy.addedAt === null)).toBe(true);
  });

  it("filters to exposed and to unexposed", async () => {
    await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      exposed: true,
    });
    const exposed = await listEntityToolPolicies(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      exposed: true,
    });
    expect(exposed.ok && exposed.value).toHaveLength(1);
    const hidden = await listEntityToolPolicies(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      exposed: false,
    });
    expect(hidden.ok && hidden.value).toHaveLength(1);
  });
});

describe("writing an entity tool policy", () => {
  it("resyncs the derived allowlist, which is what a hot path reads", async () => {
    await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      exposed: true,
    });
    const described = await describeMcpSurface(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
    });
    expect(described.ok && described.value.config.toolAllowlist).toEqual(["files.upload"]);
  });

  it("SHRINKS the allowlist on a revocation, and reports it if the write failed", async () => {
    await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      exposed: true,
    });
    await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      exposed: false,
    });
    const described = await describeMcpSurface(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
    });
    expect(described.ok && described.value.config.toolAllowlist).toEqual([]);
  });

  it("keeps the half of the label column a partial patch did not mention", async () => {
    await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      exposed: true,
      scopeLabels: ["mcp:tools", "billing"],
      allowedPatIds: ["pat-1"],
    });
    const patched = await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      scopeLabels: ["mcp:tools"],
    });
    expect(patched.ok && patched.value.allowedPatIds).toEqual(["pat-1"]);
    expect(patched.ok && patched.value.scopeLabels).toEqual(["mcp:tools"]);
  });

  it("refuses a tool the entity does not expose in this environment", async () => {
    const missing = await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-nope"),
      exposed: true,
    });
    expect(!missing.ok && missing.error.code).toBe("TOOLS_TOOL_NOT_FOUND");
  });

  it("refuses a metadata grant", async () => {
    const readOnly = await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      exposed: true,
    });
    expect(!readOnly.ok && readOnly.error.code).toBe("TOOLS_SCOPE_MISMATCH");
  });
});

describe("what one inbound caller may see", () => {
  const caller: McpCaller = { identityMode: "bearer", principalId: "mcp:pat:pat-1", scopes: [] };

  it("shows nothing before an operator exposes anything, which is default-deny", async () => {
    const listed = await listCallableForMcpCaller(context.dependencies, context.scope, ENTITY, caller);
    expect(listed.ok && listed.value).toEqual([]);
  });

  it("shows a tool once it is exposed and the caller's identity reaches it", async () => {
    await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      exposed: true,
      scopeLabels: [],
    });
    const listed = await listCallableForMcpCaller(context.dependencies, context.scope, ENTITY, caller);
    expect(listed.ok && listed.value.map((entry) => entry.toolName)).toEqual(["files.upload"]);
  });

  it("hides a tool whose policy outlived its exposure", async () => {
    await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      exposed: true,
      scopeLabels: [],
    });
    context.repository.seedExposure(
      testExposure(context.scope, { entityId: ENTITY, enabled: false }),
    );
    const listed = await listCallableForMcpCaller(context.dependencies, context.scope, ENTITY, caller);
    expect(listed.ok && listed.value).toEqual([]);
  });
});
