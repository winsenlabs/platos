// ADR M0.3 §4 kernel port: DurableRuntime.
//
// The charter's portability requirement in one interface: "all core code depends
// on a Platos-owned DurableRuntime contract. A future provider change must be
// configuration/adapter work, not another domain rewrite." No domain package
// names a vendor. ADR M0.3 §7 decision 10 puts the whole vendor database behind
// this port, and §5.1(h) pins the vendor client to the single adapter directory.
//
// ADR M0.3 §7 DECISION 9, ACCEPTED WITH QUALIFICATION, is why `awaitOutcome`
// exists. Internal reverse edges (subagent, execute-as-agent, agent-as-tool)
// become durable job hops, "BUT any existing synchronous API must retain its
// observable result/error semantics through an enqueue-and-wait compatibility
// facade — the caller still receives the terminal result or error, not an
// accepted-and-detached acknowledgement. No silent conversion to
// fire-and-forget." A port offering only `dispatch` would make that qualification
// unimplementable, so the awaited form is part of the contract, not an extra.
//
// M0.4 §2 (Workflow row): an in-flight job decodes at the payload version it was
// ENQUEUED with, so a job outlives an upgrade of the binary that queued it.

import type { JsonValue } from "../vo/domain-event.js";
import type { DomainError } from "../vo/error.js";
import type { RequestScope } from "../vo/scope.js";

export type JobId = string & { readonly __brand?: "JobId" };

/** Opaque to every caller. Its format is the adapter's business (M0.4 §2). */
export type ResumeToken = string & { readonly __brand?: "ResumeToken" };

export interface JobRequest<Payload extends JsonValue = JsonValue> {
  /** Platos-owned job name. Never a vendor task identifier. */
  readonly jobName: string;
  /** Payload schema version, frozen for the life of this job (M0.4 §2). */
  readonly payloadVersion: number;
  readonly payload: Payload;
  readonly scope: RequestScope;
  /**
   * Makes enqueueing idempotent. Two dispatches with the same key yield the same
   * job; computed over a version-stable subset of the input, never the whole body.
   */
  readonly idempotencyKey: string | null;
  readonly startAfter: Date | null;
}

export type JobState = "queued" | "running" | "suspended" | "succeeded" | "failed" | "cancelled";

export interface JobHandle {
  readonly jobId: JobId;
  readonly state: JobState;
  /** How many times the runtime has executed this job, including the first. */
  readonly executionCount: number;
}

export type JobOutcome<Value extends JsonValue = JsonValue> =
  | { readonly state: "succeeded"; readonly value: Value }
  | { readonly state: "failed"; readonly error: DomainError }
  | { readonly state: "cancelled" };

/**
 * A durable pause. A job parks here — awaiting a human approval, an external
 * callback or a sibling job — and resumes when the token is resolved, possibly
 * hours later and possibly on a different binary.
 */
export interface Suspension {
  readonly resumeToken: ResumeToken;
  readonly expiresAt: Date | null;
}

export interface DurableRuntime {
  /** Enqueue and return immediately. */
  dispatch<Payload extends JsonValue>(request: JobRequest<Payload>): Promise<JobHandle>;

  /**
   * Enqueue and wait for the terminal outcome — the compatibility facade ADR
   * M0.3 §7 decision 9 requires. `timeoutMs` bounds the wait, not the job: on
   * timeout the job keeps running and the caller is told so.
   */
  awaitOutcome<Payload extends JsonValue, Value extends JsonValue>(
    request: JobRequest<Payload>,
    timeoutMs: number,
  ): Promise<JobOutcome<Value> | { readonly state: "running"; readonly handle: JobHandle }>;

  describe(jobId: JobId): Promise<JobHandle | null>;

  cancel(jobId: JobId): Promise<void>;

  /** Park the running job. The token is minted by the adapter and is opaque. */
  suspend(jobId: JobId, expiresAt: Date | null): Promise<Suspension>;

  /**
   * Resume a parked job. Idempotent: resolving an already-resolved or expired
   * token is reported, never silently accepted, so a double-click on an approval
   * cannot resume a job twice.
   */
  resume<Value extends JsonValue>(token: ResumeToken, value: Value): Promise<"resumed" | "already-resolved" | "expired">;
}
