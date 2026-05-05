/**
 * @platosdev/client — background-operations (BGO) surface (Theme I.2; renamed
 * under Theme BGO).
 *
 * Mirrors the agent's B.5 meta-tools as first-class SDK calls so
 * integrators don't need two clients. Every method reuses
 * `PlatosClient._fetch` (retry, 401-refresh, typed errors) and the same
 * auth mode the caller configured on the client.
 *
 * Exposed on `PlatosClient` as both `client.bgo` (canonical, Theme BGO)
 * and `client.trigger` (deprecated alias — removed in the next major).
 * Both point at the same `TriggerApi` instance; the internal class name
 * is retained as `TriggerApi` because it wraps the underlying trigger.dev
 * engine. See `docs/BGO_RENAME.md`.
 *
 * Convention:
 *   - `bgo.tasks.*`    → background-operation catalog (list / trigger)
 *   - `bgo.runs.*`     → individual run lifecycle (get / cancel /
 *                        replay / list)
 *   - `bgo.schedules.*`→ schedule CRUD
 *   - `bgo.batches.*`  → batch spawns
 *
 * For ops that the agent service already mirrors (e.g. `list_bgos` a.k.a.
 * `list_tasks`, `list_runs`) we target the agent `/api/v1/agent/trigger/*`
 * shim which enforces scope filtering; the pure trigger.dev API under
 * `/api/v1/*` on the webapp is still accessible directly via `bgo.raw()`.
 */

import type { PlatosClient } from "../client.js";
import type { PlatosScope } from "../types.js";

export interface TriggerTaskCatalogEntry {
  id: string;
  name?: string;
  filePath?: string;
  exportName?: string;
  [extra: string]: unknown;
}

export interface TriggerRunSummary {
  id: string;
  taskId: string;
  status: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown> | null;
  [extra: string]: unknown;
}

export interface TriggerScheduleSummary {
  id: string;
  taskId: string;
  cron: string;
  timezone?: string | null;
  active: boolean;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  [extra: string]: unknown;
}

export interface TriggerTaskOptions {
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  delay?: string | Date;
  ttl?: string;
  tags?: string[];
  [extra: string]: unknown;
}

export interface TriggerHandle {
  id: string;
  publicAccessToken?: string;
  [extra: string]: unknown;
}

export class TriggerApi {
  readonly tasks: TriggerTasksApi;
  readonly runs: TriggerRunsApi;
  readonly schedules: TriggerSchedulesApi;
  readonly batches: TriggerBatchesApi;

  constructor(private readonly client: PlatosClient) {
    this.tasks = new TriggerTasksApi(client);
    this.runs = new TriggerRunsApi(client);
    this.schedules = new TriggerSchedulesApi(client);
    this.batches = new TriggerBatchesApi(client);
  }

  /**
   * Escape hatch — hit any trigger.dev webapp endpoint directly. Scope
   * headers are attached automatically; pass `body` / method as usual.
   *
   *   const res = await client.bgo.raw("/api/v1/runs?limit=10");
   *   // or (deprecated alias): client.trigger.raw(...)
   */
  async raw<T = unknown>(
    path: string,
    init: RequestInit = {},
    scope?: PlatosScope,
  ): Promise<T> {
    return this.client._fetch<T>(path, init, scope);
  }
}

class TriggerTasksApi {
  constructor(private readonly client: PlatosClient) {}

  /** List background operations in the caller's scope (mirrors the `list_bgos` meta-tool — formerly `list_tasks`). */
  async list(scope?: PlatosScope): Promise<TriggerTaskCatalogEntry[]> {
    const res = await this.client._fetch<{ tasks: TriggerTaskCatalogEntry[] }>(
      "/api/v1/agent/trigger/tasks",
      { method: "GET" },
      scope,
    );
    return res?.tasks ?? [];
  }

  /**
   * Trigger a task by id. Returns a handle containing the `runId` —
   * feed that to `runs.get()` or subscribe via a `threads.send` stream
   * for realtime updates.
   */
  async trigger<TPayload = unknown>(
    taskId: string,
    payload: TPayload,
    options: TriggerTaskOptions = {},
    scope?: PlatosScope,
  ): Promise<TriggerHandle> {
    return this.client._fetch<TriggerHandle>(
      `/api/v1/agent/trigger/tasks/${encodeURIComponent(taskId)}/trigger`,
      {
        method: "POST",
        body: JSON.stringify({ payload, options }),
      },
      scope,
    );
  }
}

class TriggerRunsApi {
  constructor(private readonly client: PlatosClient) {}

  /** Recent runs for the caller's scope. Mirrors the `list_runs` meta-tool. */
  async list(
    query: { taskId?: string; status?: string; limit?: number } = {},
    scope?: PlatosScope,
  ): Promise<TriggerRunSummary[]> {
    const qs = new URLSearchParams();
    if (query.taskId) qs.set("taskId", query.taskId);
    if (query.status) qs.set("status", query.status);
    if (query.limit) qs.set("limit", String(query.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const res = await this.client._fetch<{ runs: TriggerRunSummary[] }>(
      `/api/v1/agent/trigger/runs${suffix}`,
      { method: "GET" },
      scope,
    );
    return res?.runs ?? [];
  }

  /** Fetch a run's status + output + recent logs. */
  async get(runId: string, scope?: PlatosScope): Promise<TriggerRunSummary> {
    return this.client._fetch<TriggerRunSummary>(
      `/api/v1/agent/trigger/runs/${encodeURIComponent(runId)}`,
      { method: "GET" },
      scope,
    );
  }

  /** Cancel a running run. Mirrors `cancel_run` meta-tool — approval gated. */
  async cancel(runId: string, scope?: PlatosScope): Promise<{ status: string }> {
    return this.client._fetch<{ status: string }>(
      `/api/v1/agent/trigger/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST" },
      scope,
    );
  }

  /** Replay a finished / failed run. */
  async replay(runId: string, scope?: PlatosScope): Promise<TriggerHandle> {
    return this.client._fetch<TriggerHandle>(
      `/api/v1/agent/trigger/runs/${encodeURIComponent(runId)}/replay`,
      { method: "POST" },
      scope,
    );
  }
}

class TriggerSchedulesApi {
  constructor(private readonly client: PlatosClient) {}

  async list(scope?: PlatosScope): Promise<TriggerScheduleSummary[]> {
    const res = await this.client._fetch<{ schedules: TriggerScheduleSummary[] }>(
      "/api/v1/agent/trigger/schedules",
      { method: "GET" },
      scope,
    );
    return res?.schedules ?? [];
  }

  async create(
    body: { taskId: string; cron: string; timezone?: string; payload?: unknown },
    scope?: PlatosScope,
  ): Promise<TriggerScheduleSummary> {
    return this.client._fetch<TriggerScheduleSummary>(
      "/api/v1/agent/trigger/schedules",
      { method: "POST", body: JSON.stringify(body) },
      scope,
    );
  }

  async activate(scheduleId: string, scope?: PlatosScope): Promise<TriggerScheduleSummary> {
    return this.client._fetch<TriggerScheduleSummary>(
      `/api/v1/agent/trigger/schedules/${encodeURIComponent(scheduleId)}/activate`,
      { method: "POST" },
      scope,
    );
  }

  async deactivate(scheduleId: string, scope?: PlatosScope): Promise<TriggerScheduleSummary> {
    return this.client._fetch<TriggerScheduleSummary>(
      `/api/v1/agent/trigger/schedules/${encodeURIComponent(scheduleId)}/deactivate`,
      { method: "POST" },
      scope,
    );
  }

  async delete(scheduleId: string, scope?: PlatosScope): Promise<void> {
    await this.client._fetch<void>(
      `/api/v1/agent/trigger/schedules/${encodeURIComponent(scheduleId)}`,
      { method: "DELETE" },
      scope,
    );
  }
}

class TriggerBatchesApi {
  constructor(private readonly client: PlatosClient) {}

  /** Fire N tasks in parallel via a single call. Mirrors `spawn_batch`. */
  async trigger<TPayload = unknown>(
    taskId: string,
    payloads: TPayload[],
    options: TriggerTaskOptions = {},
    scope?: PlatosScope,
  ): Promise<{ batchId: string; runIds: string[] }> {
    return this.client._fetch<{ batchId: string; runIds: string[] }>(
      `/api/v1/agent/trigger/batches/${encodeURIComponent(taskId)}`,
      {
        method: "POST",
        body: JSON.stringify({ payloads, options }),
      },
      scope,
    );
  }

  async get(batchId: string, scope?: PlatosScope): Promise<{ id: string; status: string; runIds: string[] }> {
    return this.client._fetch<{ id: string; status: string; runIds: string[] }>(
      `/api/v1/agent/trigger/batches/${encodeURIComponent(batchId)}`,
      { method: "GET" },
      scope,
    );
  }
}
