// Builders for this context's two aggregates and the commands that reach them.
//
// Every builder takes a partial override and fills the rest with a VALID default,
// so a test states only the field it is about. A test that must say six
// irrelevant things to say one relevant thing is a test whose point is invisible.

import { asIdentifier, type JsonValue } from "@platos/kernel";

import {
  type AgentId,
  type Approval,
  type ApprovalId,
  type ApprovalRequest,
  type ApprovalRowId,
  type ExecutionRequest,
  type Job,
  type JobId,
  type JobKey,
  type StoredInvocationType,
} from "../../domain/index.js";

const EPOCH = new Date("2026-01-01T00:00:00.000Z");

export function aJob(overrides: Partial<Job> = {}): Job {
  return {
    jobId: asIdentifier<JobId>("job-0001"),
    jobKey: asIdentifier<JobKey>("nightly-rollup"),
    displayName: "Nightly rollup",
    description: null,
    invocationType: "manual" as StoredInvocationType,
    schedule: { cron: null, timezone: null },
    allowedAgentIds: [],
    payloadSchema: null,
    handler: "async function run(payload, ctx) { return { ok: true }; }",
    budget: { timeoutSeconds: 300, maxRetries: 3 },
    status: "active",
    createdBy: "user-1",
    lastStartedAt: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  };
}

export function anApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    rowId: asIdentifier<ApprovalRowId>("appr-row-0001"),
    approvalId: asIdentifier<ApprovalId>("appr-0001"),
    source: "request_approval",
    agentId: null,
    threadId: null,
    turnId: null,
    action: "Delete the production database",
    details: null,
    toolName: null,
    arguments: null,
    requestedBy: "user-1",
    requestDigest: null,
    requestedByTokenId: null,
    status: "pending",
    timeoutSeconds: 300,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    resolution: null,
    consumedAt: null,
    outcome: null,
    ...overrides,
  };
}

export function anApprovalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: asIdentifier<ApprovalId>("appr-0001"),
    source: "request_approval",
    action: "Delete the production database",
    details: null,
    agentId: null,
    threadId: null,
    turnId: null,
    toolName: null,
    arguments: null,
    requestedBy: "user-1",
    requestedByTokenId: null,
    requestDigest: null,
    timeoutSeconds: 300,
    ...overrides,
  };
}

export function anExecutionRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    requestId: asIdentifier("req-1"),
    jobId: asIdentifier<JobId>("job-0001"),
    payload: {} as JsonValue,
    scope: {
      organizationId: "org-1",
      projectId: "proj-1",
      environmentId: "env-1",
      userId: null,
    },
    invokedBy: "manual",
    agentId: null,
    ...overrides,
  };
}

/** A well-formed execution BODY, for exercising the admission gate. */
export function anExecutionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req-1",
    jobId: "job-0001",
    payload: {},
    scope: { organizationId: "org-1", projectId: "proj-1", environmentId: "env-1" },
    invokedBy: "manual",
    ...overrides,
  };
}

export function anAgentId(value = "agent-1"): AgentId {
  return asIdentifier<AgentId>(value);
}
