/**
 * Theme MCPF-W5 — Knowledge Graph MCP tools (8 tools).
 *
 * Wraps `KnowledgeGraphService` so MCP clients can manage the per-user
 * entity + relationship graph end-to-end. The graph is the structural
 * complement to `memories.*`: memories are facts, entities/edges are the
 * topology those facts hang on.
 *
 * Tools:
 *   • `kg.list_entities`   — paginate entities for a user (read)
 *   • `kg.search_entities` — substring search over label + aliases (read)
 *   • `kg.get_entity`      — entity row + outbound/inbound relationships (read)
 *   • `kg.create_node`     — upsert by entityKey; returns created flag (mutate)
 *   • `kg.update_node`     — partial patch (label/aliases/metadata) (mutate)
 *   • `kg.delete_node`     — cascade delete (entity + edges); approval-gated
 *   • `kg.link_nodes`      — create a relationship row (mutate)
 *   • `kg.discover_links`  — shared-neighbor link suggestions; approval-gated
 *
 * Tier-1 require_approval (set in `permission-gateway.service.ts`
 * PLATFORM_TIER_MINIMUMS):
 *   - kg.delete_node     (irreversible cascade across entity + every edge)
 *   - kg.discover_links  (O(n²) candidate scan; potentially expensive)
 *
 * Audit redaction:
 *   • Mutations log `{ entityId, entityType }` only — never the label or
 *     metadata (those are PII and are encrypted at rest in the DB).
 *   • `kg.discover_links` audit row records the result count only —
 *     never the suggested entity pairs.
 */

import type { KnowledgeGraphService } from "../../memory/knowledge-graph.service";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";
import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

function tuple(scope: RequestScope): ScopeTuple {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

export function buildKgToolHandlers(deps: {
  graph: KnowledgeGraphService;
  toolAudit: ToolAuditService;
}): McpToolHandler[] {
  const { graph, toolAudit } = deps;

  /**
   * Fire-and-forget audit trail for mutating kg.* tools. Mirrors the
   * shape used by other MCPF waves (entities.ts, platos-control.ts,
   * tools/index.ts) so MCP-driven graph edits surface in the same
   * dashboard rows as REST writes.
   *
   * `args` is sanitised by the caller before passing in here — never
   * the raw input — so labels/metadata/PII don't reach the audit log.
   */
  function auditKgMutation(
    scope: RequestScope,
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    status: "success" | "failed",
    startedAt: number,
    error?: string,
  ): void {
    toolAudit
      .record({
        scope: tuple(scope),
        toolName,
        userId: scope.userId ?? null,
        args,
        result,
        ...(error !== undefined ? { error } : {}),
        status,
        latencyMs: Date.now() - startedAt,
        source: "mcp_platform",
      })
      .catch(() => undefined);
  }

  return [
    {
      name: "kg.list_entities",
      description:
        "List knowledge-graph entities for a user in scope. Newest-first " +
        "by createdAt. Optional `entityType` filter (e.g. 'person', 'org', " +
        "'project'). Returns up to 500 rows per page.",
      inputSchema: {
        type: "object",
        required: ["userId"],
        properties: {
          userId: { type: "string" },
          entityType: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
          offset: { type: "integer", minimum: 0, maximum: 10000 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const userId = String(params["userId"]);
        const entityType = params["entityType"] as string | undefined;
        const limit = (params["limit"] as number | undefined) ?? 100;
        const offset = (params["offset"] as number | undefined) ?? 0;
        const entities = await graph.getEntities(tuple(scope), {
          userId,
          ...(entityType ? { entityType } : {}),
          limit,
          offset,
        });
        return { entities, count: entities.length };
      },
    },
    {
      name: "kg.search_entities",
      description:
        "Substring-match search over entity `label` + `aliases` for a " +
        "user. Case-insensitive. Returns scored matches: 1.0 exact, 0.9 " +
        "prefix, 0.7 label-contains, 0.5 alias-contains. MVP scoring — " +
        "for >1k entities/user consider trgm or pgvector. Hard-capped to " +
        "100 results.",
      inputSchema: {
        type: "object",
        required: ["userId", "query"],
        properties: {
          userId: { type: "string" },
          query: { type: "string", minLength: 1 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const userId = String(params["userId"]);
        const query = String(params["query"]);
        const limit = (params["limit"] as number | undefined) ?? 20;
        const results = await graph.searchEntities(tuple(scope), {
          userId,
          query,
          limit,
        });
        return { results, count: results.length };
      },
    },
    {
      name: "kg.get_entity",
      description:
        "Fetch a single entity by id with its outbound + inbound " +
        "relationships (each joined with the counterpart entity row). " +
        "Cross-scope ids return `{ error: 'not_found' }`.",
      inputSchema: {
        type: "object",
        required: ["entityId"],
        properties: { entityId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const out = await graph.getRelationships(tuple(scope), { entityId });
        if (!out) return { error: "not_found", entityId };
        return out;
      },
    },
    {
      name: "kg.create_node",
      description:
        "Upsert an entity by `entityKey` (per-user stable identifier). " +
        "Repeated calls with the same key are idempotent — second + later " +
        "calls update the label/aliases/metadata if supplied but keep the " +
        "id stable. Returns `{ entity, created }` where `created` is true " +
        "iff this call inserted a new row (createdAt === updatedAt).",
      inputSchema: {
        type: "object",
        required: ["userId", "entityKey"],
        properties: {
          userId: { type: "string" },
          entityKey: { type: "string", minLength: 1 },
          entityType: { type: "string" },
          label: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          metadata: {},
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const userId = String(params["userId"]);
        const entityKey = String(params["entityKey"]);
        const entityType = params["entityType"] as string | undefined;
        const label = params["label"] as string | undefined;
        const aliases = params["aliases"] as string[] | undefined;
        const metadata = params["metadata"];
        const auditArgs: Record<string, unknown> = {
          userId,
          entityKey,
          ...(entityType !== undefined ? { entityType } : {}),
        };
        try {
          const entity = await graph.upsertEntity(tuple(scope), {
            userId,
            entityKey,
            ...(entityType !== undefined ? { entityType } : {}),
            ...(label !== undefined ? { label } : {}),
            ...(aliases !== undefined ? { aliases } : {}),
            ...(metadata !== undefined ? { metadata } : {}),
          });
          // Detect create-vs-update: upsert sets updatedAt = createdAt on
          // a fresh insert, but the @updatedAt clock may bump on update so
          // we treat them as equal within ±1 ms to be defensive.
          const created =
            Math.abs(entity.createdAt.getTime() - entity.updatedAt.getTime()) <= 1;
          auditKgMutation(
            scope,
            "kg.create_node",
            auditArgs,
            { entityId: entity.id, entityType: entity.entityType, created },
            "success",
            startedAt,
          );
          return { entity, created };
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditKgMutation(scope, "kg.create_node", auditArgs, null, "failed", startedAt, message);
          return { error: "create_failed", message };
        }
      },
    },
    {
      name: "kg.update_node",
      description:
        "Partial-patch update of an entity by id. Only `label`, `aliases`, " +
        "`metadata`, `entityType` may be patched — `entityKey` is the " +
        "upsert key and immutable. Cross-scope ids return " +
        "`{ error: 'not_found' }` rather than mutating.",
      inputSchema: {
        type: "object",
        required: ["entityId"],
        properties: {
          entityId: { type: "string" },
          label: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          metadata: {},
          entityType: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const entityId = String(params["entityId"]);
        const patch: { label?: string; aliases?: string[]; metadata?: unknown; entityType?: string } = {};
        if (params["label"] !== undefined) patch.label = String(params["label"]);
        if (params["aliases"] !== undefined) patch.aliases = params["aliases"] as string[];
        if (params["metadata"] !== undefined) patch.metadata = params["metadata"];
        if (params["entityType"] !== undefined) patch.entityType = String(params["entityType"]);
        const auditArgs: Record<string, unknown> = {
          entityId,
          patchedFields: Object.keys(patch),
        };
        try {
          const entity = await graph.updateEntityById(tuple(scope), entityId, patch);
          if (!entity) {
            auditKgMutation(
              scope,
              "kg.update_node",
              auditArgs,
              null,
              "failed",
              startedAt,
              "entity not found in scope",
            );
            return { error: "not_found", entityId };
          }
          auditKgMutation(
            scope,
            "kg.update_node",
            auditArgs,
            { entityId: entity.id, entityType: entity.entityType },
            "success",
            startedAt,
          );
          return { entity };
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditKgMutation(scope, "kg.update_node", auditArgs, null, "failed", startedAt, message);
          return { error: "update_failed", message };
        }
      },
    },
    {
      name: "kg.delete_node",
      description:
        "Cascade-delete an entity AND every relationship pointing to or " +
        "from it. Irreversible — prefer pruning relationships first if " +
        "you only meant to disconnect. Cross-scope ids return " +
        "`{ ok: false }` rather than 404 so probes don't leak existence. " +
        "Approval-gated.",
      inputSchema: {
        type: "object",
        required: ["entityId"],
        properties: { entityId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const entityId = String(params["entityId"]);
        const auditArgs = { entityId };
        try {
          const out = await graph.deleteEntity(tuple(scope), entityId);
          auditKgMutation(
            scope,
            "kg.delete_node",
            auditArgs,
            { ok: out.ok, deletedRelationships: out.deletedRelationships },
            "success",
            startedAt,
          );
          return { ok: out.ok, entityId, deletedRelationships: out.deletedRelationships };
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditKgMutation(scope, "kg.delete_node", auditArgs, null, "failed", startedAt, message);
          return { error: "delete_failed", message };
        }
      },
    },
    {
      name: "kg.link_nodes",
      description:
        "Create a directed relationship row between two entities. Both " +
        "endpoints must live in the same scope + userId — cross-user " +
        "edges are rejected. `relationshipType` is free-form (e.g. " +
        "'works_at', 'owns', 'mentions', 'prefers'). Optional `weight` " +
        "carries strength/confidence (0..1 typical), `metadata` is freeform.",
      inputSchema: {
        type: "object",
        required: ["userId", "fromEntityId", "toEntityId", "relationshipType"],
        properties: {
          userId: { type: "string" },
          fromEntityId: { type: "string" },
          toEntityId: { type: "string" },
          relationshipType: { type: "string", minLength: 1 },
          weight: { type: ["number", "null"] },
          metadata: {},
          sourceMemoryId: { type: ["string", "null"] },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const userId = String(params["userId"]);
        const fromEntityId = String(params["fromEntityId"]);
        const toEntityId = String(params["toEntityId"]);
        const relationshipType = String(params["relationshipType"]);
        const weight = (params["weight"] as number | null | undefined) ?? null;
        const metadata = params["metadata"];
        const sourceMemoryId = (params["sourceMemoryId"] as string | null | undefined) ?? null;
        const auditArgs: Record<string, unknown> = {
          userId,
          fromEntityId,
          toEntityId,
          relationshipType,
        };
        try {
          const relationship = await graph.createRelationship(tuple(scope), {
            userId,
            fromEntityId,
            toEntityId,
            relationshipType,
            weight,
            ...(metadata !== undefined ? { metadata } : {}),
            sourceMemoryId,
          });
          auditKgMutation(
            scope,
            "kg.link_nodes",
            auditArgs,
            { relationshipId: relationship.id, relationshipType },
            "success",
            startedAt,
          );
          return { relationship };
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditKgMutation(scope, "kg.link_nodes", auditArgs, null, "failed", startedAt, message);
          return { error: "link_failed", message };
        }
      },
    },
    {
      name: "kg.discover_links",
      description:
        "Suggest candidate relationships using a shared-neighbor heuristic: " +
        "find pairs of entities that share at least `minSharedNeighbors` " +
        "common neighbors but aren't directly linked yet. Sorted by shared " +
        "count desc, capped at 50 suggestions, hard cap at 5000 entities. " +
        "If `autoLink: true` is passed, each suggestion is materialised as " +
        "a `relationshipType: 'discovered_link'` edge via best-effort " +
        "per-pair writes — successful writes commit individually, and any " +
        "per-pair failures are returned in a `errors` array (the rest still " +
        "proceed). Approval-gated (potentially expensive).",
      inputSchema: {
        type: "object",
        required: ["userId"],
        properties: {
          userId: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
          minSharedNeighbors: { type: "integer", minimum: 1, maximum: 100 },
          autoLink: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const userId = String(params["userId"]);
        const limit = (params["limit"] as number | undefined) ?? 20;
        const minSharedNeighbors = (params["minSharedNeighbors"] as number | undefined) ?? 2;
        const autoLink = params["autoLink"] === true;
        const auditArgs: Record<string, unknown> = { userId, limit, minSharedNeighbors, autoLink };
        try {
          const out = await graph.discoverLinks(tuple(scope), {
            userId,
            limit,
            minSharedNeighbors,
          });

          // Audit row records ONLY counts, never the suggested pairs.
          if (!autoLink) {
            auditKgMutation(
              scope,
              "kg.discover_links",
              auditArgs,
              { suggestionCount: out.suggestions.length, autoLinked: 0 },
              "success",
              startedAt,
            );
            return { suggestions: out.suggestions, autoLinked: 0 };
          }

          // autoLink: materialise each suggestion as a `discovered_link`
          // edge. createRelationship validates scope + endpoint userId
          // for each pair; if any one fails, the rest still proceed
          // (best-effort). Returns the linked count + any per-pair errors.
          const linked: Array<{ fromId: string; toId: string; relationshipId: string }> = [];
          const errors: Array<{ fromId: string; toId: string; message: string }> = [];
          for (const s of out.suggestions) {
            try {
              const rel = await graph.createRelationship(tuple(scope), {
                userId,
                fromEntityId: s.from.id,
                toEntityId: s.to.id,
                relationshipType: "discovered_link",
                weight: Math.min(1, s.sharedNeighbors / 10),
                metadata: { reason: s.reason, sharedNeighbors: s.sharedNeighbors },
              });
              linked.push({ fromId: s.from.id, toId: s.to.id, relationshipId: rel.id });
            } catch (err: any) {
              errors.push({
                fromId: s.from.id,
                toId: s.to.id,
                message: err?.message ?? String(err),
              });
            }
          }

          auditKgMutation(
            scope,
            "kg.discover_links",
            auditArgs,
            {
              suggestionCount: out.suggestions.length,
              autoLinked: linked.length,
              errorCount: errors.length,
            },
            "success",
            startedAt,
          );
          return {
            suggestions: out.suggestions,
            autoLinked: linked.length,
            linked,
            ...(errors.length > 0 ? { errors } : {}),
          };
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditKgMutation(scope, "kg.discover_links", auditArgs, null, "failed", startedAt, message);
          return { error: "discover_failed", message };
        }
      },
    },
  ];
}
