/** Canonical Platos Job API. */

import type { PlatosClient } from "../client.js";
import type { PlatosScope } from "../types.js";

export interface PlatosJob {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown> | null;
  [extra: string]: unknown;
}

export interface JobOptions {
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  delay?: string | Date;
  ttl?: string;
  tags?: string[];
  [extra: string]: unknown;
}

export interface JobHandle {
  jobId: string;
  [extra: string]: unknown;
}

/** @deprecated since 1.0.0; Job creation no longer uses a task catalog. Removed in 2.0.0. */
export interface TriggerTaskCatalogEntry {
  id: string;
  name?: string;
  [extra: string]: unknown;
}

/** @deprecated since 1.0.0; schedule Jobs through the canonical Jobs API. Removed in 2.0.0. */
export interface TriggerScheduleSummary {
  id: string;
  cron: string;
  active: boolean;
  [extra: string]: unknown;
}

export class JobsApi {
  constructor(private readonly client: PlatosClient) {}

  async list(
    query: { type?: string; status?: string; limit?: number } = {},
    scope?: PlatosScope,
  ): Promise<PlatosJob[]> {
    const qs = new URLSearchParams();
    if (query.type) qs.set("type", query.type);
    if (query.status) qs.set("status", query.status);
    if (query.limit) qs.set("limit", String(query.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const res = await this.client._fetch<{ jobs: PlatosJob[] }>(
      `/api/v1/agent/jobs${suffix}`,
      { method: "GET" },
      scope,
    );
    return res?.jobs ?? [];
  }

  async spawn<TPayload = unknown>(
    type: string,
    payload: TPayload,
    options: JobOptions = {},
    scope?: PlatosScope,
  ): Promise<JobHandle> {
    return this.client._fetch<JobHandle>(
      "/api/v1/agent/jobs",
      { method: "POST", body: JSON.stringify({ type, payload, options }) },
      scope,
    );
  }

  async get(jobId: string, scope?: PlatosScope): Promise<PlatosJob> {
    return this.client._fetch<PlatosJob>(
      `/api/v1/agent/jobs/${encodeURIComponent(jobId)}`,
      { method: "GET" },
      scope,
    );
  }

  async cancel(jobId: string, scope?: PlatosScope): Promise<{ status: string }> {
    return this.client._fetch<{ status: string }>(
      `/api/v1/agent/jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST" },
      scope,
    );
  }

  async replay(jobId: string, scope?: PlatosScope): Promise<JobHandle> {
    return this.client._fetch<JobHandle>(
      `/api/v1/agent/jobs/${encodeURIComponent(jobId)}/replay`,
      { method: "POST" },
      scope,
    );
  }
}

/** @deprecated since 1.0.0; use `PlatosJob`. Removed in 2.0.0. */
export type TriggerRunSummary = PlatosJob;
/** @deprecated since 1.0.0; use `JobOptions`. Removed in 2.0.0. */
export type TriggerTaskOptions = JobOptions;
/** @deprecated since 1.0.0; use `JobHandle`. Removed in 2.0.0. */
export type TriggerHandle = JobHandle;
