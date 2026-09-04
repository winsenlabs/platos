import { asIdentifier, projectScope, type EntityId, type PrincipalId } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asToolsIdentifier,
  DEFAULT_MCP_RATE_LIMIT_PER_MINUTE,
  type EntityMcpConfig,
  type ExposureId,
  type ExternalEntityId,
  type ToolId,
  type ToolName,
} from "../domain/index.js";
import { MCP_TOOLS_PERMISSION, type PrincipalAuthorizationView } from "./authorization.js";
import {
  listCallableForMcpCaller,
  listEntityToolPolicies,
  setEntityToolPolicy,
} from "./entity-tool-policy.js";
import { describeMcpSurface } from "./mcp-surface.js";
import {
  buildToolsTestContext,
  otherEnvironment,
  testExposure,
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

  it("REPORTS a revocation whose allowlist resync did not land", async () => {
    await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      exposed: true,
    });
    const granted = await context.repository.findMcpConfig(context.scope, ENTITY);
    expect(granted.ok && granted.value?.toolAllowlist).toEqual([
      asToolsIdentifier<ToolName>("files.upload"),
    ]);

    // Now revoke it with the config write broken. The POLICY row is written and
    // the CACHE is not, so the two disagree — and the operator who asked for
    // the revocation is the one person who must find out. An audit write that
    // fails is a lost record; an allowlist that fails to shrink is a tool still
    // named after somebody revoked it.
    context.repository.failOperations.add("saveMcpConfig");
    const revoked = await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      exposed: false,
    });
    expect(revoked.ok).toBe(false);
    expect(!revoked.ok && revoked.error.code).toBe("TOOLS_REPOSITORY_UNAVAILABLE");

    // The stale cache is exactly the state the refusal warns about, and
    // asserting it is what makes the warning non-vacuous rather than a
    // pessimistic error nobody can act on.
    context.repository.failOperations.clear();
    const after = await context.repository.findMcpConfig(context.scope, ENTITY);
    expect(after.ok && after.value?.toolAllowlist).toEqual([
      asToolsIdentifier<ToolName>("files.upload"),
    ]);
  });

  it("REFUSES rather than reporting success when the allowlist cannot be recomputed", async () => {
    // The other half of the same seam: the resync's READ fails, not its write.
    // Both must reach the caller, because an exposure granted against a cache
    // that could not be recomputed is a permission nobody can account for.
    context.repository.failOperations.add("findMcpConfig");
    const granted = await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      exposed: true,
    });
    expect(!granted.ok && granted.error.code).toBe("TOOLS_REPOSITORY_UNAVAILABLE");
  });
});

// The hosted MCP surface: `/mcp/entity/:id`, called by a third party holding a
// bearer credential. This is the one surface in this context whose caller is
// NOT an operator and NOT the in-process agent runtime, so it is the one that
// owes an authentication gate of its own — ADR M0.3 §3's `auth -> tool-gateway`
// fix, running at the moment of the call rather than at login.
//
// EVERY TEST BELOW IS A REFUSAL EXCEPT TWO, AND THAT RATIO IS THE POINT. The
// happy path proved nothing about this surface: before WIN-256 wired the gate,
// `listCallableForMcpCaller` took the caller's own description of itself as an
// argument and answered from it, so all three of its tests passed with the
// surface switched OFF and with no credential presented at all.
const TOKEN = "mcp-pat-live";

function principal(overrides: Partial<PrincipalAuthorizationView> = {}): PrincipalAuthorizationView {
  return {
    principalId: asIdentifier<PrincipalId>("mcp:pat:pat-1"),
    tier: "END_USER",
    credentialId: "cred-1",
    scope: { kind: "ENVIRONMENT", tenant: context.scope },
    permissions: [MCP_TOOLS_PERMISSION],
    ...overrides,
  };
}

/** Expose `tool-1` and switch the surface on — the shape a live surface has. */
async function liveSurface(scopeLabels: readonly string[] = []): Promise<void> {
  await setEntityToolPolicy(context.dependencies, {
    authorization: context.tenancy.grant(),
    entityId: ENTITY,
    toolId: asToolsIdentifier<ToolId>("tool-1"),
    exposed: true,
    scopeLabels: [...scopeLabels],
  });
  context.repository.seedMcpConfig(config({ enabled: true }));
}

describe("what one authenticated inbound caller may see", () => {
  it("shows a tool once it is exposed, the surface is on, and the credential holds mcp:tools", async () => {
    await liveSurface();
    context.identityAccess.seed(TOKEN, principal());
    const listed = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: TOKEN,
    });
    expect(listed.ok && listed.value.map((entry) => entry.toolName)).toEqual(["files.upload"]);
  });

  it("shows nothing before an operator exposes anything, which is default-deny", async () => {
    context.repository.seedMcpConfig(config({ enabled: true }));
    context.identityAccess.seed(TOKEN, principal());
    const listed = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: TOKEN,
    });
    expect(listed.ok && listed.value).toEqual([]);
  });

  it("hides a tool whose policy outlived its exposure", async () => {
    await liveSurface();
    context.identityAccess.seed(TOKEN, principal());
    context.repository.seedExposure(
      testExposure(context.scope, { entityId: ENTITY, enabled: false }),
    );
    const listed = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: TOKEN,
    });
    expect(listed.ok && listed.value).toEqual([]);
  });

  // ---- gate 1: WHO -------------------------------------------------------
  //
  // Four refusals, one per way `authenticateBearer` can say no. All four run
  // against a surface that is switched ON and holding an exposed tool, so a
  // pass would be the surface genuinely leaking rather than an empty listing
  // that happened to look like a denial.

  it("REFUSES a caller presenting no credential at all", async () => {
    await liveSurface();
    context.identityAccess.seed(TOKEN, principal());
    const listed = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: null,
    });
    expect(listed.ok).toBe(false);
    expect(!listed.ok && listed.error.code).toBe("UNAUTHENTICATED");
  });

  it("REFUSES an unknown bearer credential", async () => {
    await liveSurface();
    context.identityAccess.seed(TOKEN, principal());
    const listed = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: "mcp-pat-forged",
    });
    expect(!listed.ok && listed.error.code).toBe("UNAUTHENTICATED");
  });

  it("REFUSES a real credential minted for another environment", async () => {
    await liveSurface();
    // A genuine, unrevoked credential — for somebody else's environment. The
    // scope is handed to `authenticateBearer` rather than compared afterwards,
    // so the cross-scope decision is made by the context that owns it.
    context.identityAccess.seed(
      TOKEN,
      principal({ scope: { kind: "ENVIRONMENT", tenant: otherEnvironment() } }),
    );
    const listed = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: TOKEN,
    });
    expect(!listed.ok && listed.error.code).toBe("FORBIDDEN_SCOPE");
  });

  it("ADMITS a credential scoped to the parent project, because the rule is CONTAINMENT", async () => {
    await liveSurface();
    // identity-access's `assertAuthorizes` is `contains`, not equality: a
    // project-scoped credential reaches every environment under it. Pinned here
    // because narrowing the rule to equality is a silent denial nobody notices
    // until a legitimate project-wide token stops working in production.
    context.identityAccess.seed(
      TOKEN,
      principal({
        scope: {
          kind: "PROJECT",
          tenant: projectScope(context.scope.organizationId, context.scope.projectId),
        },
      }),
    );
    const listed = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: TOKEN,
    });
    expect(listed.ok && listed.value.map((entry) => entry.toolName)).toEqual(["files.upload"]);
  });

  it("REFUSES a credential for this scope that does not carry mcp:tools", async () => {
    await liveSurface();
    // Every other permission in the world, and not the one this surface asks
    // for. `MCP_TOOLS_PERMISSION` is the COARSE gate: it says the credential is
    // for the tool surface at all, before any per-tool policy is consulted.
    context.identityAccess.seed(
      TOKEN,
      principal({ permissions: ["threads:read", "memories:write", "mcp:prompts"] }),
    );
    const listed = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: TOKEN,
    });
    expect(!listed.ok && listed.error.code).toBe("FORBIDDEN_SCOPE");
  });

  // ---- gate 2: IS THE SURFACE ON ------------------------------------------

  it("REFUSES every caller while the operator kill switch is off", async () => {
    await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      exposed: true,
      scopeLabels: [],
    });
    // The tool IS exposed and the credential IS good. `enabled` is the only
    // thing standing between this caller and the listing, which is exactly
    // what makes the switch worth having.
    context.identityAccess.seed(TOKEN, principal());
    const listed = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: TOKEN,
    });
    expect(!listed.ok && listed.error.code).toBe("TOOLS_MCP_DISABLED");
  });

  it("switching the surface off takes effect on the NEXT call, not on the next resync", async () => {
    await liveSurface();
    context.identityAccess.seed(TOKEN, principal());
    const before = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: TOKEN,
    });
    expect(before.ok && before.value).toHaveLength(1);

    // Note what is NOT touched: the allowlist cache still names the tool, and
    // the policy row still says ALLOW. A reader that consulted either would
    // still be serving this tool.
    context.repository.seedMcpConfig(
      config({ enabled: false, toolAllowlist: [asToolsIdentifier<ToolName>("files.upload")] }),
    );
    const after = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: TOKEN,
    });
    expect(!after.ok && after.error.code).toBe("TOOLS_MCP_DISABLED");
  });

  it("REFUSES an entity that has no hosted surface in this scope", async () => {
    context.identityAccess.seed(TOKEN, principal());
    const listed = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: asIdentifier<EntityId>("entity-pk-elsewhere"),
      presentedToken: TOKEN,
    });
    expect(!listed.ok && listed.error.code).toBe("TOOLS_ENTITY_NOT_IN_SCOPE");
  });

  // ---- gate 3: WHICH TOOLS THIS CALLER'S IDENTITY REACHES -----------------

  it("EXCLUDES a tool whose scope labels the caller does not hold", async () => {
    await liveSurface(["billing"]);
    // Authenticated, in scope, holding `mcp:tools` — and not `billing`. The
    // coarse gate passed and the fine one did not, which is the two-gate design
    // doing what it is for.
    context.identityAccess.seed(TOKEN, principal());
    const listed = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: TOKEN,
    });
    expect(listed.ok && listed.value).toEqual([]);
  });

  it("EXCLUDES a tool an operator has explicitly un-exposed", async () => {
    await liveSurface();
    await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      exposed: false,
    });
    context.identityAccess.seed(TOKEN, principal());
    const listed = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: TOKEN,
    });
    expect(listed.ok && listed.value).toEqual([]);
  });

  it("EXCLUDES a tool that names permitted tokens this caller is not among", async () => {
    context.repository.seedMcpConfig(config({ enabled: true }));
    await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      exposed: true,
      scopeLabels: [],
      allowedPatIds: ["pat-somebody-else"],
    });
    context.identityAccess.seed(TOKEN, principal());
    const listed = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: TOKEN,
    });
    expect(listed.ok && listed.value).toEqual([]);
  });

  it("ADMITS a tool that names this caller's own token id", async () => {
    context.repository.seedMcpConfig(config({ enabled: true }));
    await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      exposed: true,
      scopeLabels: [],
      allowedPatIds: ["pat-1"],
    });
    // The mirror of the exclusion above, and the reason both are here: the id
    // matched is the one identity-access resolved for the presented credential,
    // so a caller cannot join a token allowlist by naming a member of it.
    context.identityAccess.seed(TOKEN, principal());
    const listed = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: TOKEN,
    });
    expect(listed.ok && listed.value.map((entry) => entry.toolName)).toEqual(["files.upload"]);
  });

  it("takes the caller's labels from the VERIFIED principal, not from the request", async () => {
    await liveSurface(["billing"]);
    // The same request as the exclusion above. The only thing that changed is
    // what identity-access says the credential carries — which is the whole
    // point of deriving the caller instead of accepting one.
    context.identityAccess.seed(
      TOKEN,
      principal({ permissions: [MCP_TOOLS_PERMISSION, "billing"] }),
    );
    const listed = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: TOKEN,
    });
    expect(listed.ok && listed.value.map((entry) => entry.toolName)).toEqual(["files.upload"]);
  });

  it("REFUSES a bearer caller on a surface configured for oidc, however permissive the tool", async () => {
    await setEntityToolPolicy(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      exposed: true,
      scopeLabels: [],
      minIdentityMode: "anonymous",
    });
    // The TOOL would take anyone. The SURFACE would not, and the surface's mode
    // floors the tool's rather than the other way round — a per-tool setting
    // that could downgrade the surface is the loosening the lattice forbids.
    context.repository.seedMcpConfig(config({ enabled: true, identityMode: "oidc" }));
    context.identityAccess.seed(TOKEN, principal());
    const listed = await listCallableForMcpCaller(context.dependencies, {
      scope: context.scope,
      entityId: ENTITY,
      presentedToken: TOKEN,
    });
    expect(listed.ok && listed.value).toEqual([]);
  });
});
