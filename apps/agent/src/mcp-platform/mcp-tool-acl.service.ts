import { Inject, Injectable } from "@nestjs/common";
import { PolicyEffect } from "@platos/tenancy-database";
import {
  type ControlDatabaseClient,
  PRISMA_TOKEN,
} from "../shared/database.provider";

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

interface PolicyWithTool {
  id: string;
  environmentId: string;
  entityId: string;
  toolId: string;
  effect: PolicyEffect;
  minIdentityMode: string;
  scopeLabels: string[];
  addedBy: string;
  addedAt: Date;
  lastReviewedAt: Date | null;
  tool: { name: string };
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

/** PIFSP-25 — clean-schema, default-deny entity tool policy service. */
@Injectable()
export class McpToolAclService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
  ) {}

  private projectPolicy(policy: PolicyWithTool): ToolAclRow {
    const labels = decodeLabels(policy.scopeLabels);
    return {
      id: policy.id,
      entityPk: policy.entityId,
      toolId: policy.toolId,
      toolName: policy.tool.name,
      exposed: policy.effect === PolicyEffect.ALLOW,
      minIdentityMode: policy.minIdentityMode,
      allowedPatIds: labels.allowedPatIds,
      scopeLabels: labels.scopeLabels,
      addedAt: policy.addedAt,
      lastReviewedAt: policy.lastReviewedAt,
    };
  }

  async list(
    entityPk: string,
    environmentId: string,
    options: { exposed?: boolean; search?: string; limit?: number; offset?: number } = {},
  ): Promise<{ tools: ToolAclListRow[]; total: number; limit: number; offset: number }> {
    const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(options.limit, 200, 1, 200);
    const policyScope = { environmentId, entityId: entityPk, effect: PolicyEffect.ALLOW };
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
      entityId: entityPk,
      environmentId,
      enabled: true,
      ...(Object.keys(toolWhere).length > 0 ? { tool: toolWhere } : {}),
    };
    const { mappings, policies, total } = await this.prisma.$transaction(async (tx) => {
      const [count, page] = await Promise.all([
        tx.environmentEntityTool.count({ where }),
        tx.environmentEntityTool.findMany({
          where,
          select: {
            id: true,
            toolId: true,
            tool: { select: { name: true } },
          },
          orderBy: [{ tool: { name: "asc" } }, { id: "asc" }],
          skip: offset,
          take: limit,
        }),
      ]);
      const pagePolicies = page.length === 0
        ? []
        : await tx.entityToolPolicy.findMany({
            where: {
              environmentId,
              entityId: entityPk,
              toolId: { in: page.map((mapping) => mapping.toolId) },
            },
            include: { tool: { select: { name: true } } },
          });
      return { mappings: page, policies: pagePolicies, total: count };
    });
    const policyByToolId = new Map(
      policies.map((policy) => [policy.toolId, this.projectPolicy(policy)]),
    );

    const tools: ToolAclListRow[] = mappings.map((mapping) => {
      const policy = policyByToolId.get(mapping.toolId);
      if (!policy) {
        return {
          id: mapping.id,
          entityPk,
          toolId: mapping.id,
          toolName: mapping.tool.name,
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
    return { tools, total, limit, offset };
  }

  async getExposedToolNames(entityPk: string): Promise<string[]> {
    const rows = await this.prisma.entityToolPolicy.findMany({
      where: { entityId: entityPk, effect: PolicyEffect.ALLOW },
      select: { tool: { select: { name: true } } },
    });
    return Array.from(new Set(rows.map((row) => row.tool.name)));
  }

  /** Load every effective allow policy for a name (normally exactly one). */
  async getExposedPoliciesByName(
    entityPk: string,
    environmentId: string,
    toolName?: string,
  ): Promise<ToolAclRow[]> {
    const rows = await this.prisma.entityToolPolicy.findMany({
      where: {
        entityId: entityPk,
        environmentId,
        effect: PolicyEffect.ALLOW,
        ...(toolName ? { tool: { name: toolName } } : {}),
      },
      include: { tool: { select: { name: true } } },
    });
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
    entityPk: string,
    environmentId: string,
    toolId: string,
    toolName: string,
    addedBy: string,
    data: Partial<
      Pick<ToolAclRow, "exposed" | "minIdentityMode" | "allowedPatIds" | "scopeLabels">
    >,
  ): Promise<ToolAclRow> {
    const existing = await this.prisma.entityToolPolicy.findUnique({
      where: { environmentId_entityId_toolId: { environmentId, entityId: entityPk, toolId } },
      select: { scopeLabels: true },
    });
    const current = decodeLabels(existing?.scopeLabels ?? [DEFAULT_SCOPE]);
    const row = await this.prisma.entityToolPolicy.upsert({
      where: { environmentId_entityId_toolId: { environmentId, entityId: entityPk, toolId } },
      create: {
        environmentId,
        entityId: entityPk,
        toolId,
        effect: data.exposed ? PolicyEffect.ALLOW : PolicyEffect.DENY,
        minIdentityMode: data.minIdentityMode ?? "bearer",
        scopeLabels: encodeLabels(
          data.scopeLabels ?? [DEFAULT_SCOPE],
          data.allowedPatIds ?? [],
        ),
        addedBy,
      },
      update: {
        ...(data.exposed !== undefined && {
          effect: data.exposed ? PolicyEffect.ALLOW : PolicyEffect.DENY,
        }),
        ...(data.minIdentityMode !== undefined && {
          minIdentityMode: data.minIdentityMode,
        }),
        ...((data.scopeLabels !== undefined || data.allowedPatIds !== undefined) && {
          scopeLabels: encodeLabels(
            data.scopeLabels ?? current.scopeLabels,
            data.allowedPatIds ?? current.allowedPatIds,
          ),
        }),
      },
    });
    await this.syncAllowlist(entityPk);
    return this.projectPolicy({ ...row, tool: { name: toolName } });
  }

  async bulk(
    entityPk: string,
    environmentId: string,
    mappingIds: string[],
    action: "expose" | "hide" | "set_identity",
    options: { minIdentityMode?: string; addedBy?: string } = {},
  ): Promise<number> {
    if (mappingIds.length === 0) return 0;
    const mappings = await this.prisma.environmentEntityTool.findMany({
      where: { id: { in: mappingIds }, entityId: entityPk, environmentId },
      select: { toolId: true },
    });
    const toolIds = Array.from(new Set(mappings.map((mapping) => mapping.toolId)));
    if (toolIds.length === 0) return 0;

    await this.prisma.$transaction(
      toolIds.map((toolId) =>
        this.prisma.entityToolPolicy.upsert({
          where: { environmentId_entityId_toolId: { environmentId, entityId: entityPk, toolId } },
          create: {
            environmentId,
            entityId: entityPk,
            toolId,
            effect:
              action === "expose" ? PolicyEffect.ALLOW : PolicyEffect.DENY,
            minIdentityMode:
              action === "set_identity"
                ? options.minIdentityMode ?? "bearer"
                : "bearer",
            scopeLabels: [DEFAULT_SCOPE],
            addedBy: options.addedBy ?? "system",
          },
          update:
            action === "set_identity"
              ? { minIdentityMode: options.minIdentityMode ?? "bearer" }
              : {
                  effect:
                    action === "expose" ? PolicyEffect.ALLOW : PolicyEffect.DENY,
                },
        }),
      ),
    );
    await this.syncAllowlist(entityPk);
    return toolIds.length;
  }

  async autoInsert(
    entityPk: string,
    environmentId: string,
    toolId: string,
    _toolName: string,
  ): Promise<void> {
    await this.prisma.entityToolPolicy.upsert({
      where: { environmentId_entityId_toolId: { environmentId, entityId: entityPk, toolId } },
      create: {
        environmentId,
        entityId: entityPk,
        toolId,
        effect: PolicyEffect.DENY,
        minIdentityMode: "bearer",
        scopeLabels: [DEFAULT_SCOPE],
        addedBy: "system",
      },
      update: {},
    });
  }

  private async syncAllowlist(entityPk: string): Promise<void> {
    const names = await this.getExposedToolNames(entityPk);
    await this.prisma.entityMcpConfig.updateMany({
      where: { entityId: entityPk },
      data: { toolAllowlist: names },
    });
  }
}
