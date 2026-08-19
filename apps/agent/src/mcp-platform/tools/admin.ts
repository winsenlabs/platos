/**
 * Theme K.18 — admin-tier MCP tool handlers.
 *
 * Only mounted on the router via the `requiresAdminTier: true` flag, so
 * tokens minted with `tier="scope"` can neither discover these tools in
 * `tools/list` nor call them in `tools/call`. Admin tokens also carry a
 * hardcoded tier-1 `require_approval` on every tool here (see
 * permission-gateway.service.ts PLATFORM_TIER_MINIMUMS), so each call
 * sits on a human-in-the-loop approval before it runs.
 *
 * Every handler scopes its queries to the TOKEN's `organizationId` —
 * admin tier does NOT grant cross-org access, only cross-scope within
 * the one org the token was minted against.
 *
 * Tools:
 *   - scopes.list_all
 *   - audit.cross_scope_tool_calls
 *   - budgets.rollup_org_wide
 *   - agents.census
 *   - entities.census
 *   - gdpr.export_user_everywhere
 */

import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";
import type { CostService } from "../../monitoring/cost.service";
import type { MemoryService } from "../../memory/memory.service";
import type { KnowledgeGraphService } from "../../memory/knowledge-graph.service";
import type { ControlDatabaseClient } from "../../shared/database.provider";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

interface ScopeRow {
  organizationId: string;
  organizationSlug: string;
  projectId: string;
  projectSlug: string;
  environmentId: string;
  environmentSlug: string;
  environmentType: string | null;
}

export interface AdminToolsDeps {
  prisma: ControlDatabaseClient;
  toolAudit: ToolAuditService;
  cost: CostService;
  memory: MemoryService;
  graph: KnowledgeGraphService;
}

/**
 * Walk every (org, project, env) triple the minting org holds. Used by
 * every other admin tool as the fan-out source — we never trust LLM-
 * provided org ids.
 */
async function loadOrgScopes(
  prisma: ControlDatabaseClient,
  organizationId: string,
): Promise<ScopeRow[]> {
  const envs = await prisma.environment.findMany({
    where: {
      archivedAt: null,
      project: { organizationId, archivedAt: null },
    },
    select: {
      id: true,
      slug: true,
      projectId: true,
      project: {
        select: {
          slug: true,
          organizationId: true,
          organization: { select: { slug: true } },
        },
      },
    },
    orderBy: [{ projectId: "asc" }, { slug: "asc" }],
  });
  const out: ScopeRow[] = [];
  for (const e of envs as Array<{
    id: string;
    slug: string;
    projectId: string;
    project: {
      slug: string;
      organizationId: string;
      organization: { slug: string };
    };
  }>) {
    out.push({
      organizationId: e.project.organizationId,
      organizationSlug: e.project.organization.slug,
      projectId: e.projectId,
      projectSlug: e.project.slug,
      environmentId: e.id,
      environmentSlug: e.slug,
      environmentType: null,
    });
  }
  return out;
}

function tuple(row: ScopeRow): ScopeTuple {
  return {
    organizationId: row.organizationId,
    projectId: row.projectId,
    environmentId: row.environmentId,
  };
}

export function buildAdminToolHandlers(deps: AdminToolsDeps): McpToolHandler[] {
  const { prisma, toolAudit, cost, memory, graph } = deps;

  return [
    {
      name: "scopes.list_all",
      description:
        "Admin-tier. Return every (org, project, env) tuple accessible within the token's organization. Scope-tier tokens only see the one pinned scope; admin-tier tokens see the full org tree.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute(_params, scope) {
        const rows = await loadOrgScopes(prisma, scope.organizationId);
        return {
          organizationId: scope.organizationId,
          count: rows.length,
          scopes: rows,
        };
      },
    },

    {
      name: "audit.cross_scope_tool_calls",
      description:
        "Admin-tier. Query the tool-call audit ledger across every scope in the token's organization. Same filter shape as `audit.tool_calls.query` plus an optional `scopes` array to restrict the fan-out.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          agentId: { type: "string" },
          toolName: { type: "string" },
          status: { type: "string" },
          entityId: { type: "string" },
          sinceDays: { type: "integer", minimum: 1, maximum: 365 },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          offset: { type: "integer", minimum: 0 },
          scopes: {
            type: "array",
            items: {
              type: "object",
              required: ["projectId", "environmentId"],
              properties: {
                projectId: { type: "string" },
                environmentId: { type: "string" },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const all = await loadOrgScopes(prisma, scope.organizationId);
        const requested = params["scopes"] as
          | Array<{ projectId: string; environmentId: string }>
          | undefined;
        const targets = requested
          ? all.filter((r) =>
              requested.some(
                (q) =>
                  q.projectId === r.projectId &&
                  q.environmentId === r.environmentId,
              ),
            )
          : all;

        const filters: Record<string, unknown> = {};
        for (const key of [
          "threadId",
          "agentId",
          "toolName",
          "status",
          "entityId",
          "sinceDays",
          "limit",
          "offset",
        ]) {
          if (params[key] !== undefined) filters[key] = params[key];
        }

        const perScope = await Promise.all(
          targets.map(async (t) => {
            const page = await toolAudit.list(tuple(t), filters as any);
            return {
              scope: {
                organizationId: t.organizationId,
                projectId: t.projectId,
                environmentId: t.environmentId,
              },
              projectSlug: t.projectSlug,
              environmentSlug: t.environmentSlug,
              total: page.total,
              rows: page.rows,
            };
          }),
        );

        const grandTotal = perScope.reduce((acc, s) => acc + s.total, 0);
        return {
          organizationId: scope.organizationId,
          scopeCount: targets.length,
          grandTotal,
          perScope,
        };
      },
    },

    {
      name: "budgets.rollup_org_wide",
      description:
        "Admin-tier. Aggregate spend (LLM + skill cents) across every scope in the token's organization for the requested date range. Returns a per-scope breakdown plus an org-wide total.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        properties: {
          days: { type: "integer", minimum: 1, maximum: 90 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const days = (params["days"] as number | undefined) ?? 7;
        const scopes = await loadOrgScopes(prisma, scope.organizationId);

        // Fan-out: one Redis round-trip per scope via the existing
        // CostService helper. The range helper internally pipelines day
        // keys so we stay O(scopes) round-trips.
        const perScope = await Promise.all(
          scopes.map(async (row) => {
            const total = await cost.getScopeCostRange(tuple(row), days);
            // Per-day breakdown already has costCents. We pull the
            // skill tier slice from a parallel hget — fallback to 0 if
            // the fields aren't populated.
            return {
              scope: {
                organizationId: row.organizationId,
                projectId: row.projectId,
                environmentId: row.environmentId,
              },
              projectSlug: row.projectSlug,
              environmentSlug: row.environmentSlug,
              totalCents: total.costCents,
              inputTokens: total.inputTokens,
              outputTokens: total.outputTokens,
              perDay: total.perDay,
            };
          }),
        );

        const orgTotal = perScope.reduce(
          (acc, s) => ({
            costCents: acc.costCents + s.totalCents,
            inputTokens: acc.inputTokens + s.inputTokens,
            outputTokens: acc.outputTokens + s.outputTokens,
          }),
          { costCents: 0, inputTokens: 0, outputTokens: 0 },
        );

        return {
          organizationId: scope.organizationId,
          days,
          scopeCount: scopes.length,
          orgTotal,
          scopeBreakdown: perScope,
        };
      },
    },

    {
      name: "agents.census",
      description:
        "Admin-tier. Count + list agents across every scope in the token's organization. Per-scope agents include id, name, model, isActive. Replaces the N-per-scope `agents.list` fan-out.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        properties: {
          includeInactive: { type: "boolean" },
          limitPerScope: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const includeInactive = Boolean(params["includeInactive"] ?? true);
        const limitPerScope = (params["limitPerScope"] as number) ?? 100;
        const scopes = await loadOrgScopes(prisma, scope.organizationId);

        const rows = await prisma.agentBinding.findMany({
          where: {
            environment: { project: { organizationId: scope.organizationId } },
            ...(includeInactive ? {} : { agent: { isActive: true } }),
          },
          select: {
            environmentId: true,
            agent: {
              select: {
                id: true,
                projectId: true,
                name: true,
                slug: true,
                isActive: true,
              },
            },
            activeAgentVersion: { select: { model: true } },
          },
          orderBy: { createdAt: "desc" },
        });

        const byKey = new Map<string, Array<any>>();
        for (const a of rows as Array<any>) {
          const key = `${a.agent.projectId}::${a.environmentId}`;
          const list = byKey.get(key) ?? [];
          if (list.length < limitPerScope) {
            list.push({
              id: a.agent.id,
              name: a.agent.name,
              slug: a.agent.slug,
              model: a.activeAgentVersion.model,
              isActive: a.agent.isActive,
            });
          }
          byKey.set(key, list);
        }

        const byScope = scopes.map((s) => {
          const key = `${s.projectId}::${s.environmentId}`;
          const agents = byKey.get(key) ?? [];
          return {
            scope: {
              organizationId: s.organizationId,
              projectId: s.projectId,
              environmentId: s.environmentId,
            },
            projectSlug: s.projectSlug,
            environmentSlug: s.environmentSlug,
            agentCount: agents.length,
            agents,
          };
        });

        return {
          organizationId: scope.organizationId,
          orgTotal: rows.length,
          byScope,
        };
      },
    },

    {
      name: "entities.census",
      description:
        "Admin-tier. Count + list connected entities across every scope in the token's organization. Includes connection state + last connected timestamp. PlatosConnectedEntity is keyed on (org, project) only — results are grouped by project but repeated for each environment within that project.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute(_params, scope) {
        const scopes = await loadOrgScopes(prisma, scope.organizationId);
        const entities = await prisma.entity.findMany({
          where: { project: { organizationId: scope.organizationId } },
          select: {
            id: true,
            projectId: true,
            externalId: true,
            displayName: true,
            connectionStatus: true,
            lastConnectedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        });

        const byProject = new Map<string, Array<any>>();
        for (const e of entities as Array<any>) {
          const list = byProject.get(e.projectId) ?? [];
          list.push({
            id: e.id,
            entityId: e.externalId,
            displayName: e.displayName,
            connectionStatus: e.connectionStatus,
            lastConnectedAt: e.lastConnectedAt,
          });
          byProject.set(e.projectId, list);
        }

        const byScope = scopes.map((s) => {
          const ents = byProject.get(s.projectId) ?? [];
          return {
            scope: {
              organizationId: s.organizationId,
              projectId: s.projectId,
              environmentId: s.environmentId,
            },
            projectSlug: s.projectSlug,
            environmentSlug: s.environmentSlug,
            entityCount: ents.length,
            entities: ents,
          };
        });

        // Phase-3 S5 — rename `orgTotal` → `uniqueEntities` to match the
        // semantics (entities are (org, project)-scoped, NOT per-env, so
        // `entities.length` counts distinct entity rows). Also surface
        // `scopeEntityPairs` (sum of entityCount over every scope row) for
        // operators who need the per-env tool-inventory count.
        const scopeEntityPairs = byScope.reduce(
          (acc, row) => acc + row.entityCount,
          0,
        );

        return {
          organizationId: scope.organizationId,
          uniqueEntities: entities.length,
          scopeEntityPairs,
          byScope,
        };
      },
    },

    {
      name: "gdpr.export_user_everywhere",
      description:
        "Admin-tier. GDPR DSAR export for a single user across every scope in the token's organization. Walks each (project, env) and concatenates memory + knowledge-graph bundles. Destructive flag: tier-1 require_approval + admin auto-escalate.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        required: ["userId"],
        properties: {
          userId: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const userId = String(params["userId"]);
        const scopes = await loadOrgScopes(prisma, scope.organizationId);

        const bundles = await Promise.all(
          scopes.map(async (row) => {
            const scopeTuple = tuple(row);
            // MCPF-W2 — DSAR must include archived rows. Soft-deleted
            // memories are still the user's data; excluding them would
            // silently violate GDPR's right-of-access guarantee.
            const memories = await memory.list(scopeTuple, {
              userId,
              limit: 10_000,
              includeArchived: true,
            });
            const entities = await graph.getEntities(scopeTuple, {
              userId,
              limit: 500,
            });
            const entityIds = new Set(entities.map((e) => e.id));
            const relationships: Array<Record<string, unknown>> = [];
            for (const e of entities) {
              const details = await graph.getRelationships(scopeTuple, {
                entityId: e.id,
              });
              if (!details) continue;
              for (const out of details.outbound) {
                if (!entityIds.has(out.to.id)) continue;
                relationships.push({
                  fromEntityKey: e.entityKey,
                  toEntityKey: out.to.entityKey,
                  relationshipType: out.relationship.relationshipType,
                  weight: out.relationship.weight,
                  metadata: out.relationship.metadata,
                  sourceMemoryId: out.relationship.sourceMemoryId,
                  createdAt: out.relationship.createdAt,
                });
              }
            }
            return {
              scope: scopeTuple,
              projectSlug: row.projectSlug,
              environmentSlug: row.environmentSlug,
              memoryCount: memories.length,
              entityCount: entities.length,
              relationshipCount: relationships.length,
              memories,
              entities,
              relationships,
            };
          }),
        );

        const orgTotals = bundles.reduce(
          (acc, b) => ({
            memories: acc.memories + b.memoryCount,
            entities: acc.entities + b.entityCount,
            relationships: acc.relationships + b.relationshipCount,
          }),
          { memories: 0, entities: 0, relationships: 0 },
        );

        return {
          version: 1 as const,
          exportedAt: new Date().toISOString(),
          organizationId: scope.organizationId,
          userId,
          scopeCount: scopes.length,
          orgTotals,
          bundles,
        };
      },
    },
  ];
}
