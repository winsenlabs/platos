/** Canonical Platos Job API. */

import type { PlatosClient } from "../client.js";
import type { PlatosScope } from "../types.js";

export type JobStatus =
  | "PENDING"
  | "ACTIVE"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export interface PlatosJob {
  id: string;
  jobId: string;
  displayName: string;
  description?: string | null;
  invocationType: string;
  scheduleCron?: string | null;
  scheduleTimezone?: string | null;
  allowedAgentIds: string[];
  payloadSchema?: Record<string, unknown> | null;
  handler: string;
  timeout: number;
  maxRetries: number;
  isActive: boolean;
  handlerVersion: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastStartedAt?: string | null;
}

export interface ListJobsQuery {
  page?: number;
  limit?: number;
  offset?: number;
  search?: string;
  status?: JobStatus | Lowercase<JobStatus>;
}

export interface CreateJobInput {
  jobId: string;
  displayName: string;
  description?: string;
  invocationType?: string;
  scheduleCron?: string;
  scheduleTimezone?: string;
  allowedAgentIds?: string[];
  payloadSchema?: Record<string, unknown>;
  handler: string;
  timeout?: number;
  maxRetries?: number;
}

export interface UpdateJobInput {
  displayName?: string;
  description?: string;
  invocationType?: string;
  scheduleCron?: string;
  scheduleTimezone?: string;
  allowedAgentIds?: string[];
  payloadSchema?: Record<string, unknown>;
  handler?: string;
  timeout?: number;
  maxRetries?: number;
  isActive?: boolean;
}

export interface DeleteJobResult {
  deleted: true;
}

export interface DispatchJobResult {
  accepted: boolean;
  jobId: string;
  message?: string;
}

export class JobsApi {
  constructor(private readonly client: PlatosClient) {}

  async list(query: ListJobsQuery = {}, scope?: PlatosScope): Promise<PlatosJob[]> {
    const qs = new URLSearchParams();
    if (query.page !== undefined) qs.set("page", String(query.page));
    if (query.limit !== undefined) qs.set("limit", String(query.limit));
    if (query.offset !== undefined) qs.set("offset", String(query.offset));
    if (query.search !== undefined) qs.set("search", query.search);
    if (query.status !== undefined) qs.set("status", query.status);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const response = await this.client._fetch<{ jobs: PlatosJob[] }>(
      `/api/v1/agent/jobs${suffix}`,
      { method: "GET" },
      scope,
    );
    return response?.jobs ?? [];
  }

  async create(input: CreateJobInput, scope?: PlatosScope): Promise<PlatosJob> {
    const response = await this.client._fetch<{ job: PlatosJob }>(
      "/api/v1/agent/jobs",
      { method: "POST", body: JSON.stringify(input) },
      scope,
    );
    return response.job;
  }

  async get(jobId: string, scope?: PlatosScope): Promise<PlatosJob> {
    const response = await this.client._fetch<{ job: PlatosJob }>(
      `/api/v1/agent/jobs/${encodeURIComponent(jobId)}`,
      { method: "GET" },
      scope,
    );
    return response.job;
  }

  async update(
    jobId: string,
    input: UpdateJobInput,
    scope?: PlatosScope,
  ): Promise<PlatosJob> {
    const response = await this.client._fetch<{ job: PlatosJob }>(
      `/api/v1/agent/jobs/${encodeURIComponent(jobId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
      scope,
    );
    return response.job;
  }

  async delete(jobId: string, scope?: PlatosScope): Promise<DeleteJobResult> {
    return this.client._fetch<DeleteJobResult>(
      `/api/v1/agent/jobs/${encodeURIComponent(jobId)}`,
      { method: "DELETE" },
      scope,
    );
  }

  async dispatch(
    jobId: string,
    payload: Record<string, unknown> = {},
    scope?: PlatosScope,
  ): Promise<DispatchJobResult> {
    return this.client._fetch<DispatchJobResult>(
      `/api/v1/agent/jobs/${encodeURIComponent(jobId)}/dispatch`,
      { method: "POST", body: JSON.stringify({ payload }) },
      scope,
    );
  }
}
