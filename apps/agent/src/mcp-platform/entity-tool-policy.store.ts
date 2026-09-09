// The ORM seam behind the entity tool ACL — the inbound MCP surface's
// default-deny exposure decision.
//
// WIN-268 P2. `mcp-tool-acl.service.ts` held ten `entityToolPolicy` /
// `environmentEntityTool` / `entityMcpConfig` calls AND the projection, the
// label codec and the caller filter that run on them. The codec and the filter
// are pure; the ten calls are not. This module takes the ten.
//
// ---------------------------------------------------------------------------
// EVERY ROW HERE BELONGS TO `tools`, AND SO DOES EVERY USE CASE
//
// ADR M0.3 §1 row 7 gives `EntityToolPolicy`, `EnvironmentEntityTool`,
// `EntityMcpConfig` and `Tool` to the `tools` context, and
// `packages/contexts/tools/application/entity-tool-policy.ts` already
// implements this file's whole job:
//
//   `listEntityToolPolicies` completes the listing with the synthetic denials
//   `domain/entity-policy.ts` mints — the same "a mapping without a policy gets
//   a synthetic deny row" the extraction source spells inline;
//   `setEntityToolPolicy` performs the partial-patch label merge, including the
//   reason the two halves of the `String[]` must be patched independently;
//   `resyncAllowlist` recomputes `EntityMcpConfig.toolAllowlist` after every
//   mutation and PROPAGATES its failure rather than swallowing it;
//   `listCallableForMcpCaller` is the four-gate read the caller filter belongs
//   to, with the caller DERIVED from a verified principal rather than asserted.
//
// So the use cases are not missing — this is the fourth time this programme has
// checked a "missing" thing and found it present. What is missing is a way to
// CALL them from here: see `mcp-policy.store.ts`'s header for the three
// independent measurements (no context/adapter/kernel import in `apps/agent`;
// rule (j) plus `composition-root.mjs` narrowing adapter imports to one file in
// `apps/core-api`; `tools` uncomposed for want of `ToolDispatch`, which is
// WIN-269's scope).
//
// ---------------------------------------------------------------------------
// WHAT CHANGED BEHIND THE SEAM
//
// THE SCOPED READS AND WRITES NOW REFUSE A FORGED SCOPE. The extraction source
// keyed every statement on `{ entityId, environmentId }` and never asked whether
// the environment it was handed belongs to the project and organization the
// caller claimed. `mcp-scope.ts` records why that triple cannot be trusted, and
// the destination adapter — `postgres-tenancy/src/tools-scope.ts` — already puts
// exactly this join on the front of every scoped method of the port that owns
// these rows.
//
// `getExposedToolNames` IS THE ONE METHOD THAT STAYS UNSCOPED, and that is
// deliberate rather than an oversight. It feeds `syncAllowlist`, which writes
// `EntityMcpConfig.toolAllowlist` — and `EntityMcpConfig` is keyed by ENTITY
// ALONE (`findUnique({ where: { entityId } })`), not by (environment, entity),
// while `EntityToolPolicy` is keyed by `@@unique([environmentId, entityId,
// toolId])`. Narrowing the read to one environment would write a per-entity
// cache from one environment's policies and silently drop the others'. The cache
// is a denormalisation that no authorization path reads —
// `mcp-entity.controller.ts` says in as many words that
// "EntityMcpConfig.toolAllowlist is only a compatibility/dashboard" field, and
// the destination use case's own header says the authority is the policy rows,
// always — so the mismatch is recorded here rather than "fixed" into a
// regression.

import { Inject, Injectable } from "@nestjs/common";
import { PolicyEffect } from "@platos/tenancy-database";

import { type ControlDatabaseClient, PRISMA_TOKEN } from "../shared/database.provider";
import { resolveClaimedScope, scopeAllowed, type ClaimedScope, type Scoped } from "./mcp-scope";

/** One `EnvironmentEntityTool` row, as the listing needs it. */
export interface ExposureRow {
  readonly id: string;
  readonly toolId: string;
  readonly toolName: string;
}

/** One `EntityToolPolicy` row, with the ORM enum already off it. */
export interface EntityToolPolicyRow {
  readonly id: string;
  readonly environmentId: string;
  readonly entityId: string;
  readonly toolId: string;
  readonly toolName: string;
  readonly effect: "ALLOW" | "DENY";
  readonly minIdentityMode: string;
  readonly scopeLabels: string[];
  readonly addedAt: Date;
  readonly lastReviewedAt: Date | null;
}

export interface ExposurePage {
  readonly exposures: readonly ExposureRow[];
  readonly policies: readonly EntityToolPolicyRow[];
  readonly total: number;
}

export interface PolicyPatch {
  readonly effect?: "ALLOW" | "DENY";
  readonly minIdentityMode?: string;
  readonly scopeLabels?: string[];
}

export interface EntityToolPolicyReader {
  pageExposures(
    scope: ClaimedScope,
    entityId: string,
    options: { exposed?: boolean; search?: string; limit: number; offset: number },
  ): Promise<Scoped<ExposurePage>>;
  /**
   * The inbound dispatch authority. NO scope check, and the name says why.
   *
   * The environment id here is read off the `McpBearerToken` or anonymous
   * session row that authenticated the request — a fact the credential carries,
   * not a triple a caller claimed — so there is no organization or project to
   * check it against and nothing would be gained by inventing one. The scoped
   * methods above are the operator paths, where the triple IS a claim.
   */
  listAllowedPoliciesForVerifiedEnvironment(
    verifiedEnvironmentId: string,
    entityId: string,
    toolName?: string,
  ): Promise<readonly EntityToolPolicyRow[]>;
  /** Unscoped BY DESIGN — see the header note on the allowlist cache's key. */
  exposedToolNamesForEntity(entityId: string): Promise<readonly string[]>;
  readScopeLabels(scope: ClaimedScope, entityId: string, toolId: string): Promise<Scoped<string[] | null>>;
  savePolicy(
    scope: ClaimedScope,
    entityId: string,
    toolId: string,
    addedBy: string,
    create: Required<PolicyPatch>,
    update: PolicyPatch,
  ): Promise<Scoped<EntityToolPolicyRow>>;
  toolIdsForMappings(scope: ClaimedScope, entityId: string, mappingIds: string[]): Promise<Scoped<string[]>>;
  savePolicies(
    scope: ClaimedScope,
    entityId: string,
    toolIds: string[],
    create: Required<PolicyPatch> & { addedBy: string },
    update: PolicyPatch,
  ): Promise<Scoped<number>>;
  syncAllowlist(entityId: string, names: readonly string[]): Promise<void>;
}

@Injectable()
export class EntityToolPolicyStore implements EntityToolPolicyReader {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient) {}

  async pageExposures(
    scope: ClaimedScope,
    entityId: string,
    options: { exposed?: boolean; search?: string; limit: number; offset: number },
  ): Promise<Scoped<ExposurePage>> {
    const resolved = await resolveClaimedScope(this.prisma, scope);
    if (!resolved.ok) return resolved;
    const environmentId = scope.environmentId;
    const policyScope = { environmentId, entityId, effect: PolicyEffect.ALLOW };
    const toolWhere = {
      ...(options.search
        ? { name: { contains: options.search, mode: "insensitive" as const } }
        : {}),
      ...(options.exposed === true
        ? { entityPolicies: { some: policyScope } }
        : options.exposed === false
          ? { entityPolicies: { none: policyScope } }
          : {}),
    };
    const where = {
      entityId,
      environmentId,
      enabled: true,
      ...(Object.keys(toolWhere).length > 0 ? { tool: toolWhere } : {}),
    };
    const { exposures, policies, total } = await this.prisma.$transaction(async (tx) => {
      const [count, page] = await Promise.all([
        tx.environmentEntityTool.count({ where }),
        tx.environmentEntityTool.findMany({
          where,
          select: { id: true, toolId: true, tool: { select: { name: true } } },
          orderBy: [{ tool: { name: "asc" } }, { id: "asc" }],
          skip: options.offset,
          take: options.limit,
        }),
      ]);
      const pagePolicies = page.length === 0
        ? []
        : await tx.entityToolPolicy.findMany({
            where: {
              environmentId,
              entityId,
              toolId: { in: page.map((mapping) => mapping.toolId) },
            },
            include: { tool: { select: { name: true } } },
          });
      return { exposures: page, policies: pagePolicies, total: count };
    });
    return scopeAllowed({
      exposures: exposures.map((row) => ({ id: row.id, toolId: row.toolId, toolName: row.tool.name })),
      policies: policies.map(toPolicyRow),
      total,
    });
  }

  async listAllowedPoliciesForVerifiedEnvironment(
    verifiedEnvironmentId: string,
    entityId: string,
    toolName?: string,
  ): Promise<readonly EntityToolPolicyRow[]> {
    const rows = await this.prisma.entityToolPolicy.findMany({
      where: {
        entityId,
        environmentId: verifiedEnvironmentId,
        effect: PolicyEffect.ALLOW,
        ...(toolName ? { tool: { name: toolName } } : {}),
      },
      include: { tool: { select: { name: true } } },
    });
    return rows.map(toPolicyRow);
  }

  async exposedToolNamesForEntity(entityId: string): Promise<readonly string[]> {
    const rows = await this.prisma.entityToolPolicy.findMany({
      where: { entityId, effect: PolicyEffect.ALLOW },
      select: { tool: { select: { name: true } } },
    });
    return Array.from(new Set(rows.map((row) => row.tool.name)));
  }

  async readScopeLabels(
    scope: ClaimedScope,
    entityId: string,
    toolId: string,
  ): Promise<Scoped<string[] | null>> {
    const resolved = await resolveClaimedScope(this.prisma, scope);
    if (!resolved.ok) return resolved;
    const existing = await this.prisma.entityToolPolicy.findUnique({
      where: {
        environmentId_entityId_toolId: { environmentId: scope.environmentId, entityId, toolId },
      },
      select: { scopeLabels: true },
    });
    return scopeAllowed(existing?.scopeLabels ?? null);
  }

  async savePolicy(
    scope: ClaimedScope,
    entityId: string,
    toolId: string,
    addedBy: string,
    create: Required<PolicyPatch>,
    update: PolicyPatch,
  ): Promise<Scoped<EntityToolPolicyRow>> {
    const resolved = await resolveClaimedScope(this.prisma, scope);
    if (!resolved.ok) return resolved;
    const row = await this.prisma.entityToolPolicy.upsert({
      where: {
        environmentId_entityId_toolId: { environmentId: scope.environmentId, entityId, toolId },
      },
      create: {
        environmentId: scope.environmentId,
        entityId,
        toolId,
        effect: create.effect as PolicyEffect,
        minIdentityMode: create.minIdentityMode,
        scopeLabels: create.scopeLabels,
        addedBy,
      },
      update: {
        ...(update.effect !== undefined && { effect: update.effect as PolicyEffect }),
        ...(update.minIdentityMode !== undefined && { minIdentityMode: update.minIdentityMode }),
        ...(update.scopeLabels !== undefined && { scopeLabels: update.scopeLabels }),
      },
      include: { tool: { select: { name: true } } },
    });
    return scopeAllowed(toPolicyRow(row));
  }

  async toolIdsForMappings(
    scope: ClaimedScope,
    entityId: string,
    mappingIds: string[],
  ): Promise<Scoped<string[]>> {
    const resolved = await resolveClaimedScope(this.prisma, scope);
    if (!resolved.ok) return resolved;
    const mappings = await this.prisma.environmentEntityTool.findMany({
      where: { id: { in: mappingIds }, entityId, environmentId: scope.environmentId },
      select: { toolId: true },
    });
    return scopeAllowed(Array.from(new Set(mappings.map((mapping) => mapping.toolId))));
  }

  async savePolicies(
    scope: ClaimedScope,
    entityId: string,
    toolIds: string[],
    create: Required<PolicyPatch> & { addedBy: string },
    update: PolicyPatch,
  ): Promise<Scoped<number>> {
    const resolved = await resolveClaimedScope(this.prisma, scope);
    if (!resolved.ok) return resolved;
    await this.prisma.$transaction(
      toolIds.map((toolId) =>
        this.prisma.entityToolPolicy.upsert({
          where: {
            environmentId_entityId_toolId: { environmentId: scope.environmentId, entityId, toolId },
          },
          create: {
            environmentId: scope.environmentId,
            entityId,
            toolId,
            effect: create.effect as PolicyEffect,
            minIdentityMode: create.minIdentityMode,
            scopeLabels: create.scopeLabels,
            addedBy: create.addedBy,
          },
          update: {
            ...(update.effect !== undefined && { effect: update.effect as PolicyEffect }),
            ...(update.minIdentityMode !== undefined && { minIdentityMode: update.minIdentityMode }),
          },
        }),
      ),
    );
    return scopeAllowed(toolIds.length);
  }

  async syncAllowlist(entityId: string, names: readonly string[]): Promise<void> {
    await this.prisma.entityMcpConfig.updateMany({
      where: { entityId },
      data: { toolAllowlist: [...names] },
    });
  }
}

function toPolicyRow(row: {
  id: string;
  environmentId: string;
  entityId: string;
  toolId: string;
  effect: PolicyEffect;
  minIdentityMode: string;
  scopeLabels: string[];
  addedAt: Date;
  lastReviewedAt: Date | null;
  tool: { name: string };
}): EntityToolPolicyRow {
  return {
    id: row.id,
    environmentId: row.environmentId,
    entityId: row.entityId,
    toolId: row.toolId,
    toolName: row.tool.name,
    effect: row.effect === PolicyEffect.ALLOW ? "ALLOW" : "DENY",
    minIdentityMode: row.minIdentityMode,
    scopeLabels: row.scopeLabels,
    addedAt: row.addedAt,
    lastReviewedAt: row.lastReviewedAt,
  };
}
