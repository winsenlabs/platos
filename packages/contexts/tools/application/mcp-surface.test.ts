import { asIdentifier, type EntityId } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asToolsIdentifier,
  DEFAULT_MCP_RATE_LIMIT_PER_MINUTE,
  EMPTY_AUDIT_ENVELOPE,
  type AuditEntry,
  type EntityMcpConfig,
  type ExposureId,
  type ExternalEntityId,
  type ToolCallAuditId,
  type ToolId,
  type ToolName,
} from "../domain/index.js";
import { discoverEntityTools } from "./discover-entity-tools.js";
import { setEntityToolPolicy } from "./entity-tool-policy.js";
import { configureMcpSurface, describeMcpSurface, readToolAudit } from "./mcp-surface.js";
import {
  deleteOrganizationPolicy,
  listOrganizationPolicies,
  setOrganizationPolicy,
} from "./organization-policy.js";
import {
  buildToolsTestContext,
  testExposure,
  testVaultAuthorization,
  type ToolsTestContext,
} from "./testing/index.js";

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

describe("configuring the hosted surface", () => {
  it("is not ready until it is both enabled and holding a tool", async () => {
    const enabled = await configureMcpSurface(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      enabled: true,
    });
    expect(enabled.ok && enabled.value.ready).toBe(false);

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
    expect(described.ok && described.value.ready).toBe(true);
  });

  it("refuses a rate limit that cannot bind", async () => {
    const refused = await configureMcpSurface(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      rateLimitPerMinute: 0,
    });
    expect(!refused.ok && refused.error.code).toBe("TOOLS_MCP_TRANSPORT_INVALID");
  });

  it("REFUSES a metadata grant, so a read-only operator cannot make the surface public", async () => {
    // Flipping `enabled` gives a third party a public endpoint into a
    // customer's tool set, which is why this command is behind `secret:mutate`
    // and its tool is tier-1 gated as well. A `metadata` grant is a genuine,
    // tenancy-minted authorization for this exact environment — it is refused
    // on what it CARRIES, not on whether it is real.
    const refused = await configureMcpSurface(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      entityId: ENTITY,
      enabled: true,
    });
    expect(!refused.ok && refused.error.code).toBe("TOOLS_SCOPE_MISMATCH");

    // And the refusal LANDED: the switch is still off. Asserting the error
    // alone would pass against a use case that refused after writing.
    const described = await describeMcpSurface(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
    });
    expect(described.ok && described.value.config.enabled).toBe(false);
  });

  it("REFUSES a metadata grant reaching for any other field on the surface", async () => {
    // Not just `enabled`. `injectMcpContext` changes the ARGUMENTS every
    // MCP-origin call carries and `rateLimitPerMinute` is the surface's only
    // volumetric defence, so the gate is on the command and not on one field.
    const refused = await configureMcpSurface(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      entityId: ENTITY,
      injectMcpContext: true,
      rateLimitPerMinute: 5,
    });
    expect(!refused.ok && refused.error.code).toBe("TOOLS_SCOPE_MISMATCH");
    const described = await describeMcpSurface(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
    });
    expect(described.ok && described.value.config.injectMcpContext).toBe(false);
    expect(described.ok && described.value.config.rateLimitPerMinute).toBe(
      DEFAULT_MCP_RATE_LIMIT_PER_MINUTE,
    );
  });

  it("offers no way to edit the derived allowlist through this command", async () => {
    const configured = await configureMcpSurface(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      enabled: true,
      // A caller reaching for the cache is a compile error; at runtime the
      // extra key is simply not read, and the allowlist is unchanged.
      ...({ toolAllowlist: ["files.upload"] } as Record<string, unknown>),
    });
    expect(configured.ok && configured.value.config.toolAllowlist).toEqual([]);
  });
});

describe("tier-2 organization policy", () => {
  it("round-trips a block and refuses the state the column cannot hold", async () => {
    const written = await setOrganizationPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      pattern: "channels.*",
      state: "block",
    });
    expect(written.ok && written.value.effect).toBe("DENY");

    const refused = await setOrganizationPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      pattern: "channels.*",
      state: "require_approval",
    });
    expect(!refused.ok && refused.error.code).toBe("TOOLS_POLICY_EFFECT_UNSUPPORTED");
    expect(!refused.ok && refused.error.details["state"]).toBe("require_approval");
  });

  it("refuses an empty or oversized pattern", async () => {
    for (const pattern of ["   ", "x".repeat(201)]) {
      const refused = await setOrganizationPolicy(context.dependencies, {
        authorization: context.tenancy.grant(),
        pattern,
        state: "block",
      });
      expect(!refused.ok && refused.error.code).toBe("TOOLS_POLICY_PATTERN_INVALID");
    }
  });

  it("updates rather than duplicates a pattern already written", async () => {
    await setOrganizationPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      pattern: "kg.*",
      state: "block",
    });
    await setOrganizationPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      pattern: "kg.*",
      state: "auto_allow",
    });
    const listed = await listOrganizationPolicies(context.dependencies, {
      authorization: context.tenancy.grant(),
    });
    expect(listed.ok && listed.value).toHaveLength(1);
    expect(listed.ok && listed.value[0]?.effect).toBe("ALLOW");
  });

  it("reports whether a delete removed anything", async () => {
    const written = await setOrganizationPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      pattern: "kg.*",
      state: "block",
    });
    const removed =
      written.ok &&
      (await deleteOrganizationPolicy(context.dependencies, {
        authorization: context.tenancy.grant(),
        organizationMcpPolicyId: written.value.organizationMcpPolicyId,
      }));
    expect(removed && removed.ok && removed.value).toBe(true);
  });
});

describe("discovery", () => {
  beforeEach(() => {
    context.repository.seedMcpClient({
      entityId: ENTITY,
      transport: "http",
      url: "https://mcp.test/sse",
      credentialId: null,
      credentialName: null,
      headersTemplate: {},
      lastDiscoveryAt: null,
      discoveryError: null,
      createdAt: AT,
      updatedAt: AT,
    });
  });

  it("turns an answered tools/list into the same registration a wire push makes", async () => {
    context.dispatch.willDiscover([{ name: "composio.list_items" }, { name: "composio.run" }]);
    const discovered = await discoverEntityTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      externalEntityId: EXTERNAL,
      vaultAuthorization: testVaultAuthorization(),
    });
    expect(discovered.ok && discovered.value.registered).toBe(2);
    expect(discovered.ok && discovered.value.error).toBeNull();
  });

  it("does NOT write a callback URL, so the wire liveness rule cannot claim the entity", async () => {
    context.dispatch.willDiscover([{ name: "composio.run" }]);
    await discoverEntityTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      externalEntityId: EXTERNAL,
      vaultAuthorization: testVaultAuthorization(),
    });
    const listed = await context.repository.listEntityExposures(context.scope, ENTITY);
    expect(listed.ok && listed.value.every((entry) => entry.callbackUrl === "")).toBe(true);
  });

  it("stamps the failure on the client row rather than throwing it at the operator", async () => {
    context.dispatch.willFailDiscovery("connection refused");
    const discovered = await discoverEntityTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      externalEntityId: EXTERNAL,
      vaultAuthorization: testVaultAuthorization(),
    });
    // The report is `ok` with an error INSIDE it: a backend that would not
    // answer is not an operator mistake, and refusing the whole call would
    // lose the stamp that tells them which entity is unreachable.
    expect(discovered.ok).toBe(true);
    expect(discovered.ok && discovered.value.error).not.toBeNull();
    const client = await context.repository.findMcpClient(context.scope, ENTITY);
    expect(client.ok && client.value?.discoveryError).toBe(
      discovered.ok ? discovered.value.error : null,
    );
  });

  it("clears a previous failure once a pass succeeds", async () => {
    context.dispatch.willFailDiscovery("down");
    await discoverEntityTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      externalEntityId: EXTERNAL,
      vaultAuthorization: testVaultAuthorization(),
    });
    context.dispatch.willDiscover([{ name: "composio.run" }]);
    await discoverEntityTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      externalEntityId: EXTERNAL,
      vaultAuthorization: testVaultAuthorization(),
    });
    const client = await context.repository.findMcpClient(context.scope, ENTITY);
    expect(client.ok && client.value?.discoveryError).toBeNull();
    expect(client.ok && client.value?.lastDiscoveryAt).not.toBeNull();
  });

  it("FAILS CLOSED on a per-user discovery endpoint, without enumerating one user's tools", async () => {
    context.repository.seedMcpClient({
      entityId: ENTITY,
      transport: "http",
      url: "https://mcp.test/users/{{endUserId}}/sse",
      credentialId: null,
      credentialName: null,
      headersTemplate: {},
      lastDiscoveryAt: null,
      discoveryError: null,
      createdAt: AT,
      updatedAt: AT,
    });
    const discovered = await discoverEntityTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      externalEntityId: EXTERNAL,
      vaultAuthorization: testVaultAuthorization(),
    });
    expect(discovered.ok && discovered.value.error).toBe("tool requires a linked end user");
    expect(context.dispatch.discoveries).toEqual([]);
  });
});

describe("the audit trail", () => {
  /** A row at an exact instant. The store keeps write order and nothing else. */
  function seedAudit(id: string, createdAt: Date): AuditEntry {
    const entry: AuditEntry = {
      toolCallAuditId: asToolsIdentifier<ToolCallAuditId>(id),
      environmentId: context.scope.environmentId,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      toolName: asToolsIdentifier<ToolName>("files.upload"),
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
      envelope: EMPTY_AUDIT_ENVELOPE,
      createdAt,
    };
    context.repository.audit.push(entry);
    return entry;
  }

  it("clamps the window and never reads the wall clock inside the store", async () => {
    const listed = await readToolAudit(context.dependencies, {
      authorization: context.tenancy.grant(),
      sinceDays: 0,
      limit: 10_000,
    });
    expect(listed.ok && listed.value).toEqual([]);
  });

  it("EXCLUDES a row older than the window the caller asked for", async () => {
    // The store returns both — deliberately. `pageAudit` in the double keeps
    // write order and applies no window, exactly as a real paged store would
    // leave the boundary to whoever computed it, and the header note says the
    // start instant is computed HERE from the clock port so a listing's edge
    // cannot move between the count and the page.
    context.clock.set(new Date("2026-03-01T00:00:00.000Z"));
    seedAudit("audit-old", new Date("2026-02-01T00:00:00.000Z"));
    seedAudit("audit-fresh", new Date("2026-02-27T00:00:00.000Z"));

    const listed = await readToolAudit(context.dependencies, {
      authorization: context.tenancy.grant(),
      sinceDays: 7,
    });
    expect(listed.ok && listed.value.map((entry) => entry.toolCallAuditId)).toEqual(["audit-fresh"]);
  });

  it("widens with the window rather than being a fixed horizon", async () => {
    // The same two rows and a wider ask. A filter pinned to a constant would
    // pass the test above and fail this one.
    context.clock.set(new Date("2026-03-01T00:00:00.000Z"));
    seedAudit("audit-old", new Date("2026-02-01T00:00:00.000Z"));
    seedAudit("audit-fresh", new Date("2026-02-27T00:00:00.000Z"));

    const listed = await readToolAudit(context.dependencies, {
      authorization: context.tenancy.grant(),
      sinceDays: 90,
    });
    expect(listed.ok && listed.value).toHaveLength(2);
  });

  it("refuses a caller with no genuine grant", async () => {
    const refused = await readToolAudit(context.dependencies, { authorization: { faked: true } });
    expect(refused.ok).toBe(false);
  });
});
