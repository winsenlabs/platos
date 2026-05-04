import { Injectable, Logger } from "@nestjs/common";
import type { RequestScope } from "../auth/scope.guard";
import { ToolRegistryService, type OrgToolEntry } from "./tool-registry.service";
import { filterByEntityIds as filterToolsByEntityIds } from "../agent-runtime/context-resolver";

/**
 * PIFSP-11 — the single source of truth for "given a (toolName, scope, entity_ids)
 * triple, where does this call go?"
 *
 * Before this service, routing logic was scattered across
 * `ToolExecutorService.executeInner` (inline scopedTools lookup + CTX.2 Role 3
 * entity_ids narrowing) and ad-hoc `toolRegistry.getScopedTools` callers. Each
 * place duplicated the "narrow by entity_ids → find first enabled toolName"
 * resolution. Consolidating into one service:
 *   - gives every caller the same semantics (fewer places for bugs)
 *   - returns a structured result + error codes instead of mixing {found} vs
 *     {error} shapes at each call site
 *   - lets us add disambiguation strategies without every caller changing
 *   - feeds PIFSP-21 (MCP Gateway) which needs the same routing primitive
 */

export interface ToolRouteRequest {
  scope: RequestScope;
  toolName: string;
  /**
   * Entity allow-list for this resolution. Typically
   * `sessionContext[entityIdsKey]` but any caller that has narrowed the set
   * by another means can pass it through. Empty / undefined means "no
   * entity_ids filter applied" — resolver falls back to the full scope matrix.
   */
  entityIds?: string[];
  /**
   * When multiple entities expose a tool with the same name, disambiguation:
   *   - `first-match` (default): return the oldest-registered mapping. Stable.
   *   - `error`: return `{error: "AMBIGUOUS_TOOL_ROUTE"}` with the candidate
   *     list so the caller can explicitly pick (useful for the MCP gateway
   *     where the client knows which entity it's calling).
   */
  disambiguationStrategy?: "first-match" | "error";
  /**
   * When `true`, ignore tools whose `enabled === false`. Default `true`;
   * admin / test paths may pass `false`.
   */
  enabledOnly?: boolean;
}

export interface ToolRouteMatch {
  ok: true;
  entityPk: string;
  entityId: string;        // human-readable slug
  toolId: string;          // PlatosToolDefinition.id
  toolName: string;
  callbackUrl: string;
  paramSchema: Record<string, unknown>;
  category: string | null;
  linkedAgentIds: string[];
  /**
   * Number of candidate mappings that matched before disambiguation.
   * 1 = unambiguous, N>1 = ambiguous-but-resolved-by-strategy.
   */
  matched: number;
}

export type ToolRouteError =
  | { ok: false; error: "TOOL_NOT_IN_SCOPE_OR_ENTITIES"; detail: string }
  | {
      ok: false;
      error: "AMBIGUOUS_TOOL_ROUTE";
      detail: string;
      candidates: Array<{ entityPk: string; entityId: string; toolId: string }>;
    };

export type ToolRouteResult = ToolRouteMatch | ToolRouteError;

@Injectable()
export class ToolRouterService {
  private readonly logger = new Logger(ToolRouterService.name);

  constructor(private readonly toolRegistry: ToolRegistryService) {}

  /**
   * Resolve a single tool call to its owning entity.
   *
   * Resolution order:
   *   1. Collect scoped + optionally entity_ids-filtered matrix.
   *   2. Narrow by `toolName`.
   *   3. Apply `enabledOnly`.
   *   4. If 0 matches → TOOL_NOT_IN_SCOPE_OR_ENTITIES.
   *   5. If 1 match → return as-is.
   *   6. If multiple → apply `disambiguationStrategy`:
   *      - `first-match`: pick the registry-reported first (stable by toolId).
   *      - `error`: return AMBIGUOUS_TOOL_ROUTE with candidates.
   */
  resolve(req: ToolRouteRequest): ToolRouteResult {
    const enabledOnly = req.enabledOnly ?? true;
    const strategy = req.disambiguationStrategy ?? "first-match";

    let matrix: OrgToolEntry[] = this.toolRegistry.getScopedTools(req.scope, {
      enabledOnly,
      agentId: req.scope.agentId,
    });

    if (req.entityIds && req.entityIds.length > 0) {
      matrix = filterToolsByEntityIds(matrix, req.entityIds);
    }

    const candidates = matrix.filter((t) => t.toolName === req.toolName);

    if (candidates.length === 0) {
      return {
        ok: false,
        error: "TOOL_NOT_IN_SCOPE_OR_ENTITIES",
        detail: `Tool "${req.toolName}" not found in scope ${this.formatScope(req.scope)}${
          req.entityIds && req.entityIds.length > 0
            ? ` (entity_ids=${JSON.stringify(req.entityIds)})`
            : ""
        }`,
      };
    }

    if (candidates.length === 1) {
      return this.toMatch(candidates[0]!, 1);
    }

    // Multiple matches — either a tool name collision across entities OR the
    // registry has the same tool mapped to several envs for one entity.
    if (strategy === "error") {
      return {
        ok: false,
        error: "AMBIGUOUS_TOOL_ROUTE",
        detail: `Tool "${req.toolName}" matched ${candidates.length} candidates across entities`,
        candidates: candidates.map((c) => ({
          entityPk: c.entityPk,
          entityId: c.sourceEntityId,
          toolId: c.toolId,
        })),
      };
    }

    // first-match: prefer the candidate with the lowest toolId (stable +
    // deterministic). registry doesn't expose createdAt on entries; toolId is
    // a CUID which sorts lexicographically ≈ creation order.
    const sorted = [...candidates].sort((a, b) =>
      a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : 0,
    );
    return this.toMatch(sorted[0]!, candidates.length);
  }

  /**
   * Resolve the visible entity set for an agent. Used by the preflight in
   * `AgentService.stream()` to decide whether the entity_ids mandate applies
   * (i.e., are there 2+ entities with at least one tool visible to this agent).
   *
   * Returns the list of distinct entity PKs that contribute tools to the
   * agent's matrix. `enabledOnly` defaults to true so the count reflects what
   * the LLM can actually call.
   */
  visibleEntitiesForAgent(
    scope: RequestScope,
    options: { enabledOnly?: boolean } = {},
  ): Array<{ entityPk: string; entityId: string }> {
    const matrix = this.toolRegistry.getScopedTools(scope, {
      enabledOnly: options.enabledOnly ?? true,
      agentId: scope.agentId,
    });
    const seen = new Map<string, { entityPk: string; entityId: string }>();
    for (const row of matrix) {
      if (!seen.has(row.entityPk)) {
        seen.set(row.entityPk, {
          entityPk: row.entityPk,
          entityId: row.sourceEntityId,
        });
      }
    }
    return Array.from(seen.values());
  }

  private toMatch(entry: OrgToolEntry, matched: number): ToolRouteMatch {
    return {
      ok: true,
      entityPk: entry.entityPk,
      entityId: entry.sourceEntityId,
      toolId: entry.toolId,
      toolName: entry.toolName,
      callbackUrl: entry.callbackUrl,
      paramSchema: entry.paramSchema,
      category: entry.category,
      linkedAgentIds: entry.linkedAgentIds,
      matched,
    };
  }

  private formatScope(scope: RequestScope): string {
    return `org=${scope.organizationId} project=${scope.projectId} env=${scope.environmentId}`;
  }
}
