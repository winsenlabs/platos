// In-memory doubles for the three remaining driven ports.
//
// `InMemoryIdempotencyStore` implements reserve-once for real. A double that
// always granted the reservation would make every replay and conflict test pass
// without exercising the branch, so this one holds keys, honours the TTL against
// the same clock the use cases read, and distinguishes `settle`'s update-if-
// present semantics from a blind write.
//
// `ScriptedJobHandlerRuntime` is a queue of outcomes rather than a sandbox: the
// classification of an outcome is this context's rule, and the isolation that
// produces one is the adapter's. Scripting the outcome tests the half that lives
// here.
//
// `RecordingDurableRuntime` records suspensions and resumptions so a test can
// assert that a turn actually parked — the behaviour ADR M0.3 §1 names for this
// context — rather than only that a row was written.

import {
  err,
  ok,
  type DomainError,
  type DurableRuntime,
  type JobHandle,
  type JobId as RuntimeJobId,
  type JobOutcome,
  type JobRequest,
  type JsonValue,
  type ResumeToken,
  type Result,
  type Suspension,
} from "@platos/kernel";

import {
  readableRecord,
  reservationUnavailable,
  unreadableRecord,
  type Reservation,
  type UnreadableReason,
} from "../../domain/index.js";
import type {
  HandlerInvocation,
  HandlerOutcome,
  IdempotencyKey,
  IdempotencyStore,
  JobHandlerRuntime,
  ReservationOutcome,
} from "../ports/index.js";

interface Held {
  readonly reservation: Reservation;
  readonly expiresAt: number;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly held = new Map<string, Held>();
  private pendingFailure: string | null = null;
  /**
   * Set to make the next LOST race report an unreadable record.
   *
   * WIN-260 made this a REASON rather than a flag. A double that could only
   * produce one kind of unreadable record could not exercise the three codes
   * `decideReplay` now mints, and a test asserting on all three against a double
   * that only ever emits one of them would be asserting on the double.
   */
  private corruptNext: UnreadableReason | null = null;

  constructor(private readonly now: () => Date) {}

  failNext(reason = "injected"): void {
    this.pendingFailure = reason;
  }

  /** The next `reserve` that LOSES reports an unreadable record, for `reason`. */
  corruptNextRead(reason: UnreadableReason = "absent"): void {
    this.corruptNext = reason;
  }

  private key(key: IdempotencyKey): string {
    return `${key.environmentId}:${key.requestId}`;
  }

  private live(key: string): Held | null {
    const entry = this.held.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now().getTime()) {
      this.held.delete(key);
      return null;
    }
    return entry;
  }

  async reserve(
    key: IdempotencyKey,
    reservation: Reservation,
    ttlSeconds: number,
  ): Promise<Result<ReservationOutcome>> {
    if (this.pendingFailure !== null) {
      const reason = this.pendingFailure;
      this.pendingFailure = null;
      return err(reservationUnavailable(reason));
    }
    const id = this.key(key);
    const existing = this.live(id);
    if (existing !== null) {
      if (this.corruptNext !== null) {
        const reason = this.corruptNext;
        this.corruptNext = null;
        return ok({ kind: "held", held: unreadableRecord(reason) });
      }
      return ok({ kind: "held", held: readableRecord(existing.reservation) });
    }
    this.held.set(id, { reservation, expiresAt: this.now().getTime() + ttlSeconds * 1000 });
    return ok({ kind: "reserved" });
  }

  async settle(
    key: IdempotencyKey,
    reservation: Reservation,
    ttlSeconds: number,
  ): Promise<Result<boolean>> {
    if (this.pendingFailure !== null) {
      const reason = this.pendingFailure;
      this.pendingFailure = null;
      return err(reservationUnavailable(reason));
    }
    const id = this.key(key);
    // Update-if-present: never resurrect an expired reservation.
    if (this.live(id) === null) return ok(false);
    this.held.set(id, { reservation, expiresAt: this.now().getTime() + ttlSeconds * 1000 });
    return ok(true);
  }

  peek(key: IdempotencyKey): Reservation | null {
    return this.live(this.key(key))?.reservation ?? null;
  }
}

export class ScriptedJobHandlerRuntime implements JobHandlerRuntime {
  private readonly outcomes: HandlerOutcome[] = [];
  private syntaxErrors: (string | null)[] = [];
  private runFailure: DomainError | null = null;
  readonly invocations: HandlerInvocation[] = [];

  /** Queue the outcome of the next `run`. */
  willReturn(outcome: HandlerOutcome): this {
    this.outcomes.push(outcome);
    return this;
  }

  /**
   * Make the next `run` fail as a PORT, not as a handler.
   *
   * The distinction is the whole point of this injector. Every member of
   * `HandlerOutcome` is a handler that ran and lost, and each maps to one of the
   * eleven inherited execution codes. `Result`'s error half is the other case —
   * "could not run this at all", the sandbox or the store — and it carries
   * whatever code that adapter mints, which the execution union does NOT contain.
   * `execute-job.ts::settle` must refuse to cache it; without an injector here
   * nothing could put such an error in front of that guard.
   */
  failNextRun(error: DomainError): this {
    this.runFailure = error;
    return this;
  }

  /** Queue the verdict of the next `checkSyntax`. */
  willParse(error: string | null): this {
    this.syntaxErrors.push(error);
    return this;
  }

  async run(invocation: HandlerInvocation): Promise<Result<HandlerOutcome>> {
    this.invocations.push(invocation);
    if (this.runFailure !== null) {
      const failure = this.runFailure;
      this.runFailure = null;
      return err(failure);
    }
    const next = this.outcomes.shift();
    return ok(next ?? { kind: "completed", value: null });
  }

  async checkSyntax(_source: string): Promise<Result<string | null>> {
    const next = this.syntaxErrors.shift();
    return ok(next ?? null);
  }
}

export interface RecordedSuspension {
  readonly runId: RuntimeJobId;
  readonly expiresAt: Date | null;
  readonly token: ResumeToken;
}

export interface RecordedResume {
  readonly token: ResumeToken;
  readonly value: JsonValue;
}

/**
 * A `DurableRuntime` that records what it was asked to do.
 *
 * Only `suspend` and `resume` are inhabited: they are the two this context calls.
 * The other four throw, so a use case that started calling one would fail loudly
 * rather than silently pass against a stub that returned a plausible value.
 */
export class RecordingDurableRuntime implements DurableRuntime {
  readonly suspensions: RecordedSuspension[] = [];
  readonly resumes: RecordedResume[] = [];
  private counter = 0;
  private resolved = new Set<string>();
  private suspendFailure: string | null = null;
  private resumeFailure: string | null = null;
  private resumeVerdicts: ("resumed" | "already-resolved" | "expired")[] = [];

  failNextSuspend(reason = "runtime unreachable"): void {
    this.suspendFailure = reason;
  }

  failNextResume(reason = "runtime unreachable"): void {
    this.resumeFailure = reason;
  }

  /** Force the verdict of the next `resume`. */
  willResumeWith(verdict: "resumed" | "already-resolved" | "expired"): void {
    this.resumeVerdicts.push(verdict);
  }

  async suspend(jobId: RuntimeJobId, expiresAt: Date | null): Promise<Suspension> {
    if (this.suspendFailure !== null) {
      const reason = this.suspendFailure;
      this.suspendFailure = null;
      throw new Error(reason);
    }
    this.counter += 1;
    // `ResumeToken` uses the kernel's optional-brand style rather than
    // `Branded`, so `asIdentifier` does not apply to it.
    const token: ResumeToken = `suspension-${this.counter}`;
    this.suspensions.push({ runId: jobId, expiresAt, token });
    return { resumeToken: token, expiresAt };
  }

  async resume<Value extends JsonValue>(
    token: ResumeToken,
    value: Value,
  ): Promise<"resumed" | "already-resolved" | "expired"> {
    if (this.resumeFailure !== null) {
      const reason = this.resumeFailure;
      this.resumeFailure = null;
      throw new Error(reason);
    }
    this.resumes.push({ token, value });
    const forced = this.resumeVerdicts.shift();
    if (forced !== undefined) return forced;
    if (this.resolved.has(token)) return "already-resolved";
    this.resolved.add(token);
    return "resumed";
  }

  dispatch<Payload extends JsonValue>(_request: JobRequest<Payload>): Promise<JobHandle> {
    throw new Error("jobs must not dispatch through DurableRuntime in this context");
  }

  awaitOutcome<Payload extends JsonValue, Value extends JsonValue>(
    _request: JobRequest<Payload>,
    _timeoutMs: number,
  ): Promise<JobOutcome<Value> | { readonly state: "running"; readonly handle: JobHandle }> {
    throw new Error("jobs must not awaitOutcome through DurableRuntime in this context");
  }

  describe(_jobId: RuntimeJobId): Promise<JobHandle | null> {
    throw new Error("jobs must not describe runs through DurableRuntime in this context");
  }

  cancel(_jobId: RuntimeJobId): Promise<void> {
    throw new Error("jobs must not cancel runs through DurableRuntime in this context");
  }
}
