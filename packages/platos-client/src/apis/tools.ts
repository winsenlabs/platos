/**
 * @platosdev/client — tools API surface (issue #2).
 *
 * Wraps the tool-catalog REST endpoints exposed by the agent service
 * (`apps/agent/src/agent-runtime/agent.controller.ts`). These power the
 * dashboard's Tools tab and the per-entity tool matrix UI; before this
 * namespace landed, SDK consumers had to hand-roll fetch calls with the
 * right auth + scope headers.
 */

import type { PlatosClient } from "../client.js";
import { PlatosNotFoundError } from "../errors.js";
import type { PlatosScope } from "../types.js";

export interface PlatosTool {
  readonly toolId: string;
  readonly toolName: string;
  readonly description: string;
  readonly category: string | null;
  readonly paramSchema: unknown;
  readonly entityId: string;
  readonly entityPk?: string;
  readonly callbackUrl?: string;
  readonly enabled?: boolean;
}

export interface PlatosToolHealth {
  readonly totalCalls: number;
  readonly failCount: number;
  readonly p95LatencyMs: number | null;
  readonly lastCalledAt: string | null;
}

export interface PlatosToolMatrixRow extends PlatosTool {
  readonly health?: PlatosToolHealth;
}

export interface PlatosToolStats {
  readonly toolCount: number;
  readonly entityCount: number;
  readonly bm25IndexSize?: number;
  readonly lastIndexedAt?: string;
}

export interface PlatosToolListOptions {
  /** Optional category filter (matches `PlatosToolDefinition.category`). */
  category?: string;
}

export interface PlatosToolSearchOptions {
  /** Max results to return (default 25 server-side). */
  limit?: number;
  /** Narrow the search to a single connected-entity slug. */
  entity?: string;
}

export interface PlatosToolTestResult {
  readonly status: "ok" | "error";
  readonly elapsedMs: number;
  readonly result?: unknown;
  readonly error?: string;
}

export class ToolsApi {
  constructor(private readonly client: PlatosClient) {}

  /**
   * List tools visible in scope, optionally filtered by category.
   * Backs the agent dashboard's Tools tab.
   */
  async list(opts: PlatosToolListOptions = {}, scope?: PlatosScope): Promise<PlatosTool[]> {
    const qs = opts.category
      ? `?category=${encodeURIComponent(opts.category)}`
      : "";
    const res = await this.client._fetch<{ tools: PlatosTool[] }>(
      `/api/v1/agent/tools${qs}`,
      { method: "GET" },
      scope,
    );
    return res?.tools ?? [];
  }

  /**
   * Keyword search the tool registry (BM25 server-side). Use for
   * tool-discovery UIs.
   */
  async search(
    q: string,
    opts: PlatosToolSearchOptions = {},
    scope?: PlatosScope,
  ): Promise<PlatosTool[]> {
    const params = new URLSearchParams({ q });
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.entity) params.set("entity", opts.entity);
    const res = await this.client._fetch<{ tools: PlatosTool[] }>(
      `/api/v1/agent/tools/search?${params.toString()}`,
      { method: "GET" },
      scope,
    );
    return res?.tools ?? [];
  }

  /**
   * Registry index stats — tool count, entity count, BM25 index size.
   * Mostly useful for debug + dashboard headers.
   */
  async stats(scope?: PlatosScope): Promise<PlatosToolStats | null> {
    try {
      return await this.client._fetch<PlatosToolStats>(
        "/api/v1/agent/tools/stats",
        { method: "GET" },
        scope,
      );
    } catch (err) {
      if (err instanceof PlatosNotFoundError) return null;
      throw err;
    }
  }

  /**
   * Per-entity matrix — every tool in scope with full metadata
   * (description, paramSchema, callbackUrl, enabled flag) plus health
   * data (totalCalls, failCount, p95LatencyMs, lastCalledAt). The
   * dashboard's Tools tab uses this exact shape.
   */
  async matrix(scope?: PlatosScope): Promise<PlatosToolMatrixRow[]> {
    const res = await this.client._fetch<{ tools: PlatosToolMatrixRow[] }>(
      "/api/v1/agent/tools/matrix",
      { method: "GET" },
      scope,
    );
    return res?.tools ?? [];
  }

  /**
   * Toggle a single tool's `enabled` flag on a specific entity. The
   * scope tuple defines which environment the flag applies to;
   * dev/staging/prod can independently enable/disable the same tool.
   */
  async setEnabled(
    entityId: string,
    toolName: string,
    enabled: boolean,
    scope?: PlatosScope,
  ): Promise<{ enabled: boolean }> {
    return await this.client._fetch<{ enabled: boolean }>(
      `/api/v1/agent/tools/${encodeURIComponent(entityId)}/${encodeURIComponent(toolName)}/enabled`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      },
      scope,
    );
  }

  /**
   * Invoke a tool against its entity with sample params, useful for
   * smoke-testing connections from the dashboard's Test button. Does
   * NOT count against the agent's rate limits or budgets.
   */
  async test(
    toolId: string,
    params: Record<string, unknown>,
    scope?: PlatosScope,
  ): Promise<PlatosToolTestResult> {
    return await this.client._fetch<PlatosToolTestResult>(
      `/api/v1/agent/tools/${encodeURIComponent(toolId)}/test`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ params }),
      },
      scope,
    );
  }
}
