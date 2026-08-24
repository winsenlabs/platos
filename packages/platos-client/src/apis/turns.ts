/** Canonical Platos Turn API. */

import type { PlatosClient } from "../client.js";
import type { PlatosScope } from "../types.js";

export interface PlatosTurn {
  id: string;
  agentId: string;
  threadId: string;
  status: string;
  createdAt: string;
  completedAt?: string | null;
  durationMs?: number;
  costCents?: number;
  [extra: string]: unknown;
}

export class TurnsApi {
  constructor(private readonly client: PlatosClient) {}

  async list(
    options: { agentId?: string; threadId?: string; status?: string; limit?: number } = {},
    scope?: PlatosScope,
  ): Promise<PlatosTurn[]> {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined && value !== null) qs.set(key, String(value));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const res = await this.client._fetch<{ turns: PlatosTurn[] }>(
      `/api/v1/agent/turns${suffix}`,
      { method: "GET" },
      scope,
    );
    return res?.turns ?? [];
  }

  async get(turnId: string, scope?: PlatosScope): Promise<PlatosTurn> {
    return this.client._fetch<PlatosTurn>(
      `/api/v1/agent/turns/${encodeURIComponent(turnId)}`,
      { method: "GET" },
      scope,
    );
  }
}
