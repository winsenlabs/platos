// Deterministic doubles for the kernel ports, and one call that assembles the
// whole context in memory.
//
// `MutableClock` and `SequenceIdGenerator` are why every rule in this package is
// testable at an instant: nothing reads the wall clock and nothing mints a
// random id, so "the lease has expired" is `clock.advanceSeconds(...)` and "this
// is the third event" is a literal.
//
// `RecordingDurableRuntime` is the inbound seam's double. It never runs a job —
// it records the `JobRequest` — which is precisely the assertion that matters:
// this context's obligation is to enqueue the right payload under the right job
// name with the right idempotency key, and what happens next is `conversations`'
// business and unreachable from here by design.

import {
  asIdentifier,
  environmentScope,
  type Clock,
  type DomainEvent,
  type DurableRuntime,
  type EnvironmentScope,
  type EventBus,
  type IdGenerator,
  type JobHandle,
  type JobOutcome,
  type JobRequest,
  type JsonValue,
  type LogFields,
  type Logger,
  type LogLevel,
  type ResumeToken,
  type Suspension,
  type TransactionScope,
  type Ulid,
  type UnitOfWork,
  type Unsubscribe,
  type Uuid,
} from "@platos/kernel";
import type { IdentityAccessContract } from "@platos/context-identity-access";
import type { TenancyContract } from "@platos/context-tenancy";

import {
  DEFAULT_CHANNELS_POLICY,
  type ChannelsPolicy,
} from "../../domain/index.js";
import type { ChannelsDependencies } from "../dependencies.js";
import {
  InMemoryAdapterRegistry,
  InMemoryAgentDirectory,
  InMemoryChannelAdapter,
  InMemoryCredentialReader,
  ReversibleEventCipher,
} from "./in-memory-adapters.js";
import { InMemoryChannelsRepository } from "./in-memory-channels-repository.js";

export class MutableClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date("2026-01-01T00:00:00.000Z")) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }

  set(instant: Date): void {
    this.current = new Date(instant.getTime());
  }
}

export class SequenceIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix = "id") {}

  uuid(): Uuid {
    this.counter += 1;
    return asIdentifier<Uuid>(`${this.prefix}-${String(this.counter).padStart(4, "0")}`);
  }

  ulid(): Ulid {
    this.counter += 1;
    return asIdentifier<Ulid>(`${this.prefix.toUpperCase()}${String(this.counter).padStart(4, "0")}`);
  }
}

/** Runs the work with a stable handle; no rollback semantics to simulate. */
export class ImmediateUnitOfWork implements UnitOfWork {
  private counter = 0;
  readonly transactions: TransactionScope[] = [];

  async run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
    this.counter += 1;
    const transaction: TransactionScope = { transactionId: asIdentifier(`txn-${this.counter}`) };
    this.transactions.push(transaction);
    return work(transaction);
  }
}

/** Records what was enqueued. See the header for why it never runs anything. */
export class RecordingDurableRuntime implements DurableRuntime {
  readonly dispatched: JobRequest[] = [];
  private counter = 0;

  async dispatch<Payload extends JsonValue>(request: JobRequest<Payload>): Promise<JobHandle> {
    // Idempotency is honoured, because "a redelivery does not start a second
    // turn" is the property the inbound tests exist to prove, and a double that
    // ignored the key would make that test vacuous.
    const existing = this.dispatched.findIndex(
      (candidate) =>
        candidate.idempotencyKey !== null && candidate.idempotencyKey === request.idempotencyKey,
    );
    if (existing >= 0) {
      return { jobId: `job-${existing + 1}`, state: "queued", executionCount: 0 };
    }
    this.dispatched.push(request as unknown as JobRequest);
    this.counter += 1;
    return { jobId: `job-${this.counter}`, state: "queued", executionCount: 0 };
  }

  async awaitOutcome<Payload extends JsonValue, Value extends JsonValue>(
    request: JobRequest<Payload>,
    _timeoutMs: number,
  ): Promise<JobOutcome<Value> | { readonly state: "running"; readonly handle: JobHandle }> {
    const handle = await this.dispatch(request);
    return { state: "running", handle };
  }

  async describe(): Promise<JobHandle | null> {
    return null;
  }

  async cancel(): Promise<void> {}

  async suspend(_jobId: string, expiresAt: Date | null): Promise<Suspension> {
    // `ResumeToken` is an optional-brand alias rather than a `Branded<>`, so
    // `asIdentifier` does not apply to it.
    const resumeToken: ResumeToken = "resume-1";
    return { resumeToken, expiresAt };
  }

  async resume(): Promise<"resumed" | "already-resolved" | "expired"> {
    return "resumed";
  }
}

/** Delivers synchronously so a test can assert on the handler's effects. */
export class InMemoryEventBus implements EventBus {
  readonly published: DomainEvent[] = [];
  private readonly handlers = new Map<string, Array<(event: DomainEvent) => Promise<void>>>();

  async publish(event: DomainEvent): Promise<void> {
    this.published.push(event);
    for (const handler of this.handlers.get(event.name) ?? []) await handler(event);
  }

  subscribe(eventName: string, handler: (event: DomainEvent) => Promise<void>): Unsubscribe {
    const existing = this.handlers.get(eventName) ?? [];
    existing.push(handler);
    this.handlers.set(eventName, existing);
    return () => {
      const current = this.handlers.get(eventName) ?? [];
      this.handlers.set(
        eventName,
        current.filter((candidate) => candidate !== handler),
      );
    };
  }
}

export class RecordingLogger implements Logger {
  readonly lines: Array<{ level: LogLevel; message: string; fields: LogFields }> = [];

  constructor(private readonly bound: LogFields = {}) {}

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    this.lines.push({ level, message, fields: { ...this.bound, ...fields } });
  }

  child(fields: LogFields): Logger {
    const child = new RecordingLogger({ ...this.bound, ...fields });
    // Share the sink so a test can assert on everything, however it was bound.
    Object.defineProperty(child, "lines", { value: this.lines });
    return child;
  }
}

export function testEnvironmentScope(environmentId = "env-1"): EnvironmentScope {
  return environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier(environmentId));
}

/**
 * The peer-context handles are held opaquely and never called (see
 * `application/dependencies.ts`), so the doubles are deliberately uninhabited:
 * any call on one is a defect that fails loudly rather than a stub that passes.
 */
export const uncalledTenancy = undefined as unknown as TenancyContract;
export const uncalledIdentity = undefined as unknown as IdentityAccessContract;

export interface ChannelsTestContext {
  readonly dependencies: ChannelsDependencies;
  readonly repository: InMemoryChannelsRepository;
  readonly adapter: InMemoryChannelAdapter;
  readonly adapters: InMemoryAdapterRegistry;
  readonly credentials: InMemoryCredentialReader;
  readonly agents: InMemoryAgentDirectory;
  readonly cipher: ReversibleEventCipher;
  readonly durableRuntime: RecordingDurableRuntime;
  readonly eventBus: InMemoryEventBus;
  readonly clock: MutableClock;
  readonly ids: SequenceIdGenerator;
  readonly unitOfWork: ImmediateUnitOfWork;
  readonly logger: RecordingLogger;
}

export function buildChannelsTestContext(policy: ChannelsPolicy = DEFAULT_CHANNELS_POLICY): ChannelsTestContext {
  const clock = new MutableClock();
  const repository = new InMemoryChannelsRepository();
  const adapter = new InMemoryChannelAdapter("slack");
  const adapters = new InMemoryAdapterRegistry(adapter);
  const credentials = new InMemoryCredentialReader();
  const agents = new InMemoryAgentDirectory();
  const cipher = new ReversibleEventCipher();
  const durableRuntime = new RecordingDurableRuntime();
  const eventBus = new InMemoryEventBus();
  const ids = new SequenceIdGenerator();
  const unitOfWork = new ImmediateUnitOfWork();
  const logger = new RecordingLogger();

  return {
    dependencies: Object.freeze({
      repository,
      adapters,
      credentials,
      agents,
      cipher,
      durableRuntime,
      eventBus,
      clock,
      ids,
      unitOfWork,
      logger,
      policy,
      tenancy: uncalledTenancy,
      identity: uncalledIdentity,
    }),
    repository,
    adapter,
    adapters,
    credentials,
    agents,
    cipher,
    durableRuntime,
    eventBus,
    clock,
    ids,
    unitOfWork,
    logger,
  };
}
