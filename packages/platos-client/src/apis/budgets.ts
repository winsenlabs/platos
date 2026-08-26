/**
 * @platosdev/client — budgets API (Theme H.6/H.7).
 *
 * Read-only surface over per-scope / per-agent / per-user budget caps.
 * Write paths (create/update cap) live in the webapp admin UI only —
 * this client only exposes list + status for embedded dashboards.
 * EOBD.85.
 */

import type { PlatosClient } from "../client.js";
import type { PlatosScope } from "../types.js";

export interface PlatosBudgetCap {
  id: string;
  scopeType: "scope" | "agent" | "user";
  targetId?: string | null;
  period: "hour" | "day" | "week" | "month";
  limitCents: number;
  turnsLimit?: number | null;
  alertThresholds: number[];
  alertWebhookUrl?: string | null;
  alertEmails?: string[];
}

export interface PlatosBudgetStatus {
  cap: PlatosBudgetCap;
  spentCents: number;
  reservedCents: number;
  turns: number;
  windowKey: string;
  crossedThresholds: number[];
}

export class BudgetsApi {
  constructor(private readonly client: PlatosClient) {}

  async list(scope?: PlatosScope): Promise<PlatosBudgetCap[]> {
    const res = await this.client._fetch<{ caps: PlatosBudgetCap[] }>(
      "/api/v1/agent/budgets",
      { method: "GET" },
      scope,
    );
    return res?.caps ?? [];
  }

  async status(
    options: { agentId?: string; userId?: string } = {},
    scope?: PlatosScope,
  ): Promise<{ caps: PlatosBudgetStatus[] }> {
    const qs = new URLSearchParams();
    if (options.agentId) qs.set("agentId", options.agentId);
    if (options.userId) qs.set("userId", options.userId);
    const tail = qs.toString() ? `?${qs}` : "";
    return this.client._fetch<{ caps: PlatosBudgetStatus[] }>(
      `/api/v1/agent/budgets/status${tail}`,
      { method: "GET" },
      scope,
    );
  }
}
