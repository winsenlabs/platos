/**
 * @platosdev/client — monitoring API.
 *
 * Read-only reporting surface: Turn list, trace view, cost rollups.
 * Thin wrappers over the existing webapp / agent REST endpoints.
 * EOBD.85.
 */

import type { PlatosClient } from "../client.js";
import type { PlatosScope } from "../types.js";

export interface TurnSummary {
  id: string;
  agentId: string;
  threadId: string;
  status: string;
  createdAt: string;
  durationMs?: number;
  costCents?: number;
  [extra: string]: unknown;
}

export interface CostRollupByAgent {
  agentId: string;
  costCents: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostRollupByScope {
  day: string;
  costCents: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  durationMs: number;
  attributes: Record<string, unknown>;
}

export class MonitoringApi {
  constructor(private readonly client: PlatosClient) {}

  async turns(
    options: {
      agentId?: string;
      threadId?: string;
      status?: string;
      limit?: number;
    } = {},
    scope?: PlatosScope,
  ): Promise<TurnSummary[]> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(options)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const tail = qs.toString() ? `?${qs}` : "";
    const res = await this.client._fetch<{ turns: TurnSummary[] }>(
      `/api/v1/agent/turns${tail}`,
      { method: "GET" },
      scope,
    );
    return res?.turns ?? [];
  }

  async trace(threadId: string, scope?: PlatosScope): Promise<TraceSpan[]> {
    const res = await this.client._fetch<{ spans: TraceSpan[] }>(
      `/api/v1/agent/monitoring/trace/${encodeURIComponent(threadId)}`,
      { method: "GET" },
      scope,
    );
    return res?.spans ?? [];
  }

  async costByAgent(
    options: { day?: string } = {},
    scope?: PlatosScope,
  ): Promise<CostRollupByAgent[]> {
    const qs = new URLSearchParams();
    if (options.day) qs.set("day", options.day);
    const tail = qs.toString() ? `?${qs}` : "";
    const res = await this.client._fetch<{ rollup: CostRollupByAgent[] }>(
      `/api/v1/agent/monitoring/cost-by-agent${tail}`,
      { method: "GET" },
      scope,
    );
    return res?.rollup ?? [];
  }

  async costByScope(
    options: { daysBack?: number } = {},
    scope?: PlatosScope,
  ): Promise<CostRollupByScope[]> {
    const qs = new URLSearchParams();
    if (options.daysBack) qs.set("daysBack", String(options.daysBack));
    const tail = qs.toString() ? `?${qs}` : "";
    const res = await this.client._fetch<{ rollup: CostRollupByScope[] }>(
      `/api/v1/agent/monitoring/cost${tail}`,
      { method: "GET" },
      scope,
    );
    return res?.rollup ?? [];
  }
}
