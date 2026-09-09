import { Inject, Injectable } from "@nestjs/common";

import {
  EntityToolPolicyStore,
  type EntityToolPolicyReader,
  type EntityToolPolicyRow,
} from "./entity-tool-policy.store";
import type { ClaimedScope, ScopeRefusalReason } from "./mcp-scope";

const PAT_SCOPE_PREFIX = "platos:pat:";
const DEFAULT_SCOPE = "mcp:tools";

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isInteger(value)
    ? Math.max(minimum, Math.min(maximum, value as number))
    : fallback;
}

export interface ToolAclRow {
  id: string;
  entityPk: string;
  toolId: string;
  toolName: string;
  exposed: boolean;
  minIdentityMode: string;
  allowedPatIds: string[];
  scopeLabels: string[];
  addedAt: Date;
  lastReviewedAt: Date | null;
}

/**
 * What `list()` returns to API callers. A mapping without a policy gets a
 * synthetic deny row keyed by the EnvironmentEntityTool id so it can be
 * toggled without weakening the default-deny contract.
 */
export interface ToolAclListRow extends Omit<ToolAclRow, "addedAt"> {
  addedAt: Date | null;
}

/**
 * A read or write whose claimed scope was not a real chain.
 *
 * WHY AN EXCEPTION AND NOT A FALSY RETURN. `bulk()` answers a COUNT and
 * `list()` answers a page; zero and an empty page are both legitimate answers to
 * a legitimate question, so a refusal reported through either of them would be
 * an empty result standing in for a denial — the exact defect WIN-268 P2 removed
 * from the permission gateway's tier 2. The transport maps this to 403.
 */
export class ToolAclScopeRefusedError extends Error {
  constructor(readonly reason: ScopeRefusalReason) {
    super(`claimed MCP scope is ${reason}`);
    this.name = "ToolAclScopeRefusedError";
  }
}

function unwrap<Value>(
  result: { ok: true; value: Value } | { ok: false; reason: ScopeRefusalReason },
): Value {
  if (!result.ok) throw new ToolAclScopeRefusedError(result.reason);
  return result.value;
}

function decodeLabels(labels: string[]): {
  scopeLabels: string[];
  allowedPatIds: string[];
} {
  return {
    scopeLabels: labels.filter((label) => !label.startsWith(PAT_SCOPE_PREFIX)),
    allowedPatIds: labels
      .filter((label) => label.startsWith(PAT_SCOPE_PREFIX))
      .map((label) => label.slice(PAT_SCOPE_PREFIX.length)),
  };
}

function encodeLabels(scopeLabels: string[], allowedPatIds: string[]): string[] {
  return Array.from(
    new Set([
      ...scopeLabels.filter((label) => !label.startsWith(PAT_SCOPE_PREFIX)),
      ...allowedPatIds.map((id) => `${PAT_SCOPE_PREFIX}${id}`),
    ]),
  );
}

/**
 * PIFSP-25 — clean-schema, default-deny entity tool policy service.
 *
 * ---------------------------------------------------------------------------
 * WIN-268 P2 — THE ORM LEFT THIS FILE, AND THE SCOPE BECAME A CLAIM
 *
 * The ten `entityToolPolicy` / `environmentEntityTool` / `entityMcpConfig`
 * statements are now `entity-tool-policy.store.ts`, whose header records why
 * they cannot yet be `toolsContract.listEntityToolPolicies(...)` even though
 * `tools` owns every row and already publishes every use case.
 *
 * TWO KINDS OF ENVIRONMENT REACH THIS SERVICE AND THEY ARE NOT THE SAME KIND
 * OF FACT, which is why the signatures below diverged rather than all taking a
 * scope:
 *
 *   An OPERATOR path arrives from `getOperatorScope(req)`, whose
 *   organization/project/environment triple is three unrelated request headers
 *   that nothing joins (`mcp-scope.ts` carries the measurement). It is a CLAIM,
 *   so `list`, `upsert` and `bulk` take a `ClaimedScope` and the store resolves
 *   it against the tree before touching a policy row.
 *
 *   The INBOUND MCP path arrives as `token.environmentId`, read off the
 *   `McpBearerToken` / anonymous-session row that authenticated the request.
 *   Nobody claimed it; the credential carries it. `getExposedPoliciesByName`
 *   therefore still takes a bare environment id, and saying so here is the
 *   point: a reader who "tidies" that into a `ClaimedScope` would be inventing
 *   an organization and a project the credential never named.
 */
@Injectable()
export class McpToolAclService {
  constructor(
    @Inject(EntityToolPolicyStore) private readonly store: EntityToolPolicyReader,
  ) {}

  private projectPolicy(policy: EntityToolPolicyRow): ToolAclRow {
    const labels = decodeLabels(policy.scopeLabels);
    return {
      id: policy.id,
      entityPk: policy.entityId,
      toolId: policy.toolId,
      toolName: policy.toolName,
      exposed: policy.effect === "ALLOW",
      minIdentityMode: policy.minIdentityMode,
      allowedPatIds: labels.allowedPatIds,
      scopeLabels: labels.scopeLabels,
      addedAt: policy.addedAt,
      lastReviewedAt: policy.lastReviewedAt,
    };
  }

  async list(
    scope: ClaimedScope,
    entityPk: string,
    options: { exposed?: boolean; search?: string; limit?: number; offset?: number } = {},
  ): Promise<{ tools: ToolAclListRow[]; total: number; limit: number; offset: number }> {
    const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(options.limit, 200, 1, 200);
    const page = unwrap(
      await this.store.pageExposures(scope, entityPk, {
        exposed: options.exposed,
        search: options.search,
        limit,
        offset,
      }),
    );
    const policyByToolId = new Map(
      page.policies.map((policy) => [policy.toolId, this.projectPolicy(policy)]),
    );

    const tools: ToolAclListRow[] = page.exposures.map((mapping) => {
      const policy = policyByToolId.get(mapping.toolId);
      if (!policy) {
        return {
          id: mapping.id,
          entityPk,
          toolId: mapping.id,
          toolName: mapping.toolName,
          exposed: false,
          minIdentityMode: "bearer",
          allowedPatIds: [],
          scopeLabels: [DEFAULT_SCOPE],
          addedAt: null,
          lastReviewedAt: null,
        };
      }
      // Keep the transport API's toolId as the mapping id. The controller
      // resolves it back to the canonical Tool id before mutation.
      return { ...policy, toolId: mapping.id };
    });
    return { tools, total: page.total, limit, offset };
  }

  async getExposedToolNames(entityPk: string): Promise<string[]> {
    return [...(await this.store.exposedToolNamesForEntity(entityPk))];
  }

  /**
   * Load every effective allow policy for a name (normally exactly one).
   *
   * `verifiedEnvironmentId` COMES OFF A CREDENTIAL ROW, NOT OFF A HEADER — see
   * the class banner. This is the runtime dispatch authority for the inbound
   * `/mcp/entity/:id` surface and it stays keyed on the environment the token
   * was minted in.
   */
  async getExposedPoliciesByName(
    entityPk: string,
    verifiedEnvironmentId: string,
    toolName?: string,
  ): Promise<ToolAclRow[]> {
    const rows = await this.store.listAllowedPoliciesForVerifiedEnvironment(
      verifiedEnvironmentId,
      entityPk,
      toolName,
    );
    return rows.map((row) => this.projectPolicy(row));
  }

  /** Filter exposed tools by caller identity and scopes. */
  filterByIdentity(
    rows: ToolAclRow[],
    caller: { identityMode: string; mcpUserId: string; scopes: string[] },
  ): ToolAclRow[] {
    const identityRank = (mode: string): number =>
      mode === "oidc" ? 2 : mode === "bearer" ? 1 : 0;
    return rows.filter((acl) => {
      if (identityRank(caller.identityMode) < identityRank(acl.minIdentityMode)) {
        return false;
      }
      if (acl.allowedPatIds.length > 0 && caller.identityMode === "bearer") {
        const patId = caller.mcpUserId.replace("mcp:pat:", "");
        if (!acl.allowedPatIds.includes(patId)) return false;
      }
      if (
        acl.scopeLabels.length > 0 &&
        !acl.scopeLabels.every((scope) => caller.scopes.includes(scope))
      ) {
        return false;
      }
      return true;
    });
  }

  async upsert(
    scope: ClaimedScope,
    entityPk: string,
    toolId: string,
    toolName: string,
    addedBy: string,
    data: Partial<
      Pick<ToolAclRow, "exposed" | "minIdentityMode" | "allowedPatIds" | "scopeLabels">
    >,
  ): Promise<ToolAclRow> {
    const existing = unwrap(await this.store.readScopeLabels(scope, entityPk, toolId));
    const current = decodeLabels(existing ?? [DEFAULT_SCOPE]);
    const row = unwrap(
      await this.store.savePolicy(scope, entityPk, toolId, addedBy, {
        effect: data.exposed ? "ALLOW" : "DENY",
        minIdentityMode: data.minIdentityMode ?? "bearer",
        scopeLabels: encodeLabels(
          data.scopeLabels ?? [DEFAULT_SCOPE],
          data.allowedPatIds ?? [],
        ),
      }, {
        ...(data.exposed !== undefined && { effect: data.exposed ? "ALLOW" as const : "DENY" as const }),
        ...(data.minIdentityMode !== undefined && { minIdentityMode: data.minIdentityMode }),
        ...((data.scopeLabels !== undefined || data.allowedPatIds !== undefined) && {
          scopeLabels: encodeLabels(
            data.scopeLabels ?? current.scopeLabels,
            data.allowedPatIds ?? current.allowedPatIds,
          ),
        }),
      }),
    );
    await this.syncAllowlist(entityPk);
    return this.projectPolicy({ ...row, toolName });
  }

  async bulk(
    scope: ClaimedScope,
    entityPk: string,
    mappingIds: string[],
    action: "expose" | "hide" | "set_identity",
    options: { minIdentityMode?: string; addedBy?: string } = {},
  ): Promise<number> {
    if (mappingIds.length === 0) return 0;
    const toolIds = unwrap(await this.store.toolIdsForMappings(scope, entityPk, mappingIds));
    if (toolIds.length === 0) return 0;

    const written = unwrap(
      await this.store.savePolicies(scope, entityPk, toolIds, {
        effect: action === "expose" ? "ALLOW" : "DENY",
        minIdentityMode: action === "set_identity" ? options.minIdentityMode ?? "bearer" : "bearer",
        scopeLabels: [DEFAULT_SCOPE],
        addedBy: options.addedBy ?? "system",
      }, action === "set_identity"
        ? { minIdentityMode: options.minIdentityMode ?? "bearer" }
        : { effect: action === "expose" ? "ALLOW" : "DENY" }),
    );
    await this.syncAllowlist(entityPk);
    return written;
  }

  async autoInsert(
    scope: ClaimedScope,
    entityPk: string,
    toolId: string,
    _toolName: string,
  ): Promise<void> {
    unwrap(
      await this.store.savePolicy(scope, entityPk, toolId, "system", {
        effect: "DENY",
        minIdentityMode: "bearer",
        scopeLabels: [DEFAULT_SCOPE],
      }, {}),
    );
  }

  private async syncAllowlist(entityPk: string): Promise<void> {
    await this.store.syncAllowlist(entityPk, await this.store.exposedToolNamesForEntity(entityPk));
  }
}
