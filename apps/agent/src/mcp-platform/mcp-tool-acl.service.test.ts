// WIN-268 P2 — this suite used to drive `McpToolAclService` with a fake
// `PrismaClient` and assert on the `where` clauses it produced. Those assertions
// were about the STORE, and they have gone to the store's own suites: the
// clause shapes to `entity-tool-policy.integration.test.ts`, against a real
// PostgreSQL with two tenants, where a `where` clause can be shown to actually
// exclude a foreign row instead of merely being spelled a certain way.
//
// WHAT IS LEFT HERE IS THE SERVICE'S OWN JOB, and it is not a small one: the
// default-deny completion, the two meanings packed into one `String[]`, the
// identity filter, and — new in P2 — what the service does when the store
// REFUSES. Every behavioural claim the previous suite made is still made below.
//
// THE DOUBLE IS AN `EntityToolPolicyReader`, which is the interface the service
// actually names. That is the point of the extraction: this file no longer
// contains the string `prisma`, so it cannot accidentally re-assert an ORM
// detail, and the day the reader is `toolsContract` the double changes shape and
// these cases do not.

import { beforeEach, describe, expect, it } from "vitest";

import type {
  EntityToolPolicyReader,
  EntityToolPolicyRow,
  ExposurePage,
  PolicyPatch,
} from "./entity-tool-policy.store";
import { McpToolAclService, ToolAclScopeRefusedError } from "./mcp-tool-acl.service";
import { MCP_SCOPE_FOREIGN, scopeAllowed, scopeRefused, type ClaimedScope } from "./mcp-scope";

const SCOPE: ClaimedScope = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
};

interface FakeState {
  exposures: Array<{ id: string; toolId: string; toolName: string }>;
  policies: EntityToolPolicyRow[];
  allowlist: string[];
  /** When set, EVERY scoped method refuses with this reason. */
  refuse: typeof MCP_SCOPE_FOREIGN | null;
}

function createReader(state: FakeState): EntityToolPolicyReader {
  const guard = <Value>(value: Value) =>
    state.refuse ? scopeRefused(state.refuse) : scopeAllowed(value);
  const find = (toolId: string) => state.policies.find((policy) => policy.toolId === toolId);
  return {
    async pageExposures(_scope, _entityId, options) {
      const page: ExposurePage = {
        exposures: state.exposures.slice(options.offset, options.offset + options.limit),
        policies: state.policies,
        total: state.exposures.length,
      };
      return guard(page);
    },
    async listAllowedPoliciesForVerifiedEnvironment(verifiedEnvironmentId, _entityId, toolName) {
      return state.policies.filter(
        (policy) =>
          policy.effect === "ALLOW"
          && policy.environmentId === verifiedEnvironmentId
          && (toolName === undefined || policy.toolName === toolName),
      );
    },
    async exposedToolNamesForEntity() {
      return [
        ...new Set(
          state.policies.filter((policy) => policy.effect === "ALLOW").map((policy) => policy.toolName),
        ),
      ];
    },
    async readScopeLabels(_scope, _entityId, toolId) {
      return guard(find(toolId)?.scopeLabels ?? null);
    },
    async savePolicy(_scope, entityId, toolId, addedBy, create, update) {
      if (state.refuse) return scopeRefused(state.refuse);
      const existing = find(toolId);
      const next: EntityToolPolicyRow = existing
        ? applyPatch(existing, update)
        : {
            id: "policy_1",
            environmentId: SCOPE.environmentId,
            entityId,
            toolId,
            toolName: "calendar.create",
            effect: create.effect,
            minIdentityMode: create.minIdentityMode,
            scopeLabels: create.scopeLabels,
            addedAt: new Date("2026-08-25T00:00:00.000Z"),
            lastReviewedAt: null,
          };
      void addedBy;
      state.policies = [...state.policies.filter((policy) => policy.toolId !== toolId), next];
      return scopeAllowed(next);
    },
    async toolIdsForMappings(_scope, _entityId, mappingIds) {
      return guard(
        state.exposures
          .filter((exposure) => mappingIds.includes(exposure.id))
          .map((exposure) => exposure.toolId),
      );
    },
    async savePolicies(_scope, entityId, toolIds, create, update) {
      if (state.refuse) return scopeRefused(state.refuse);
      for (const toolId of toolIds) {
        await this.savePolicy(SCOPE, entityId, toolId, create.addedBy, create, update);
      }
      return scopeAllowed(toolIds.length);
    },
    async syncAllowlist(_entityId, names) {
      state.allowlist = [...names];
    },
  };
}

function applyPatch(row: EntityToolPolicyRow, patch: PolicyPatch): EntityToolPolicyRow {
  return {
    ...row,
    ...(patch.effect !== undefined && { effect: patch.effect }),
    ...(patch.minIdentityMode !== undefined && { minIdentityMode: patch.minIdentityMode }),
    ...(patch.scopeLabels !== undefined && { scopeLabels: patch.scopeLabels }),
  };
}

describe("McpToolAclService clean policy cutover", () => {
  let state: FakeState;
  let service: McpToolAclService;

  beforeEach(() => {
    state = { exposures: [], policies: [], allowlist: [], refuse: null };
    service = new McpToolAclService(createReader(state));
  });

  it("lists enabled exposures as default-deny policies", async () => {
    state.exposures = [{ id: "mapping_1", toolId: "tool_1", toolName: "calendar.create" }];

    await expect(service.list(SCOPE, "entity_1")).resolves.toEqual({
      total: 1,
      limit: 200,
      offset: 0,
      tools: [{
        id: "mapping_1",
        entityPk: "entity_1",
        toolId: "mapping_1",
        toolName: "calendar.create",
        exposed: false,
        minIdentityMode: "bearer",
        allowedPatIds: [],
        scopeLabels: ["mcp:tools"],
        addedAt: null,
        lastReviewedAt: null,
      }],
    });
  });

  it("stores PAT restrictions as internal labels without treating them as OAuth scopes", async () => {
    const row = await service.upsert(SCOPE, "entity_1", "tool_1", "calendar.create", "user_1", {
      exposed: true,
      allowedPatIds: ["pat_1"],
    });

    expect(row.toolName).toBe("calendar.create");
    expect(row.allowedPatIds).toEqual(["pat_1"]);
    expect(row.scopeLabels).toEqual(["mcp:tools"]);
    expect(state.policies[0]?.scopeLabels).toEqual(["mcp:tools", "platos:pat:pat_1"]);
  });

  it("denies cross-scope and wrong-PAT callers while allowing a stronger identity", () => {
    const row = {
      id: "policy_1",
      entityPk: "entity_1",
      toolId: "tool_1",
      toolName: "calendar.create",
      exposed: true,
      minIdentityMode: "bearer",
      allowedPatIds: ["pat_1"],
      scopeLabels: ["mcp:tools", "calendar:write"],
      addedAt: new Date(),
      lastReviewedAt: null,
    };

    expect(
      service.filterByIdentity([row], {
        identityMode: "bearer",
        mcpUserId: "mcp:pat:pat_2",
        scopes: ["mcp:tools", "calendar:write"],
      }),
    ).toEqual([]);
    expect(
      service.filterByIdentity([row], {
        identityMode: "bearer",
        mcpUserId: "mcp:pat:pat_1",
        scopes: ["mcp:tools"],
      }),
    ).toEqual([]);
    expect(
      service.filterByIdentity([row], {
        identityMode: "oidc",
        mcpUserId: "mcp:oidc:user",
        scopes: ["mcp:tools", "calendar:write"],
      }),
    ).toEqual([row]);
  });

  it("loads runtime ALLOW rows only from the environment the credential names", async () => {
    state.policies = [
      allowRow("tool_1", "calendar.create", "env_selected"),
      allowRow("tool_2", "calendar.create", "env_other"),
    ];

    const rows = await service.getExposedPoliciesByName("entity_1", "env_selected", "calendar.create");
    expect(rows.map((row) => row.toolId)).toEqual(["tool_1"]);
  });

  it("bulk mutation resolves only mappings owned by the requested entity", async () => {
    state.exposures = [{ id: "mapping_owned", toolId: "tool_owned", toolName: "calendar.create" }];

    await expect(
      service.bulk(SCOPE, "entity_1", ["mapping_owned", "mapping_foreign"], "expose", {
        addedBy: "user_1",
      }),
    ).resolves.toBe(1);
    expect(state.policies.map((policy) => policy.toolId)).toEqual(["tool_owned"]);
  });

  it("replays the same ACL upsert to one stable policy and allowlist", async () => {
    const mutation = {
      exposed: true,
      minIdentityMode: "oidc",
      allowedPatIds: ["pat_1"],
      scopeLabels: ["mcp:tools", "calendar:write"],
    };

    const first = await service.upsert(SCOPE, "entity_1", "tool_1", "calendar.create", "user_1", mutation);
    const replay = await service.upsert(SCOPE, "entity_1", "tool_1", "calendar.create", "user_1", mutation);

    expect(replay).toEqual(first);
    expect(state.allowlist).toEqual(["calendar.create"]);
  });

  // -------------------------------------------------------------------------
  // WIN-268 P2 — A REFUSAL IS A REFUSAL, NOT AN EMPTY PAGE AND NOT A ZERO.
  //
  // `list` answers a page and `bulk` answers a count, and BOTH have legitimate
  // empty answers. Reporting a forged scope through either would put a denial
  // and a legitimate "nothing here" into the same value — which is exactly the
  // defect this tranche removed from the permission gateway's tier 2.
  // -------------------------------------------------------------------------

  it("propagates a scope refusal out of every scoped method, distinguishably", async () => {
    state.exposures = [{ id: "mapping_1", toolId: "tool_1", toolName: "calendar.create" }];
    state.refuse = MCP_SCOPE_FOREIGN;

    await expect(service.list(SCOPE, "entity_1")).rejects.toThrow(ToolAclScopeRefusedError);
    await expect(
      service.bulk(SCOPE, "entity_1", ["mapping_1"], "expose", { addedBy: "user_1" }),
    ).rejects.toThrow(ToolAclScopeRefusedError);
    await expect(
      service.upsert(SCOPE, "entity_1", "tool_1", "calendar.create", "user_1", { exposed: true }),
    ).rejects.toThrow(ToolAclScopeRefusedError);

    // And the refusal carries WHICH refusal it is, so an operator can tell a
    // forged ancestry from a deleted environment.
    await expect(service.list(SCOPE, "entity_1")).rejects.toMatchObject({
      reason: MCP_SCOPE_FOREIGN,
    });
  });

  it("MUTATION GUARD: an empty page is NOT how a refusal is reported", async () => {
    // Without this case, an implementation that swallowed the refusal and
    // returned `{ tools: [], total: 0 }` would pass every case above — the
    // suite would be asserting that a denied caller sees nothing, which is
    // indistinguishable from a caller who is allowed and has nothing.
    state.exposures = [{ id: "mapping_1", toolId: "tool_1", toolName: "calendar.create" }];
    state.refuse = null;
    const allowed = await service.list(SCOPE, "entity_1");
    expect(allowed.tools).toHaveLength(1);

    state.refuse = MCP_SCOPE_FOREIGN;
    const refused = await service.list(SCOPE, "entity_1").then(
      (page) => ({ kind: "page" as const, page }),
      (error: unknown) => ({ kind: "refusal" as const, error }),
    );
    expect(refused.kind).toBe("refusal");
  });
});

function allowRow(toolId: string, toolName: string, environmentId: string): EntityToolPolicyRow {
  return {
    id: `policy_${toolId}`,
    environmentId,
    entityId: "entity_1",
    toolId,
    toolName,
    effect: "ALLOW",
    minIdentityMode: "bearer",
    scopeLabels: ["mcp:tools"],
    addedAt: new Date("2026-08-25T00:00:00.000Z"),
    lastReviewedAt: null,
  };
}
