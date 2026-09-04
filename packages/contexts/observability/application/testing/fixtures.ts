// Deterministic doubles for the kernel ports, and one call that assembles the
// whole context in memory.
//
// `MutableClock` and `SequenceIdGenerator` are why every rule in this package is
// testable at an instant: nothing reads the wall clock and nothing mints a
// random id, so "this envelope is not due for another sixteen minutes" is
// `clock.advanceSeconds(...)` and "this is the third audit row" is a literal.
//
// `RecordingLogger` keeps what it was told. Several of this context's most
// important outputs are SENTENCES — "the store is missing its schema", "eleven
// envelopes are parked" — and a log line nobody asserts on is a log line that
// silently stops being emitted.

import {
  asIdentifier,
  environmentScope,
  type Clock,
  type DomainEvent,
  type EnvironmentScope,
  type IdGenerator,
  type LogFields,
  type Logger,
  type LogLevel,
  type TransactionScope,
  type Ulid,
  type UnitOfWork,
  type Uuid,
} from "@platos/kernel";
import type { TenancyContract } from "@platos/context-tenancy";

import { DEFAULT_DRAIN_BUDGET, type DrainBudget } from "../../domain/index.js";
import type { ObservabilityDependencies } from "../dependencies.js";
import { InMemoryObservabilitySink } from "./in-memory-observability-sink.js";
import { InMemoryProjectionOutbox } from "./in-memory-projection-outbox.js";
import {
  InMemoryErasedSubjectRegister,
  InMemoryObservabilityRepository,
  InMemorySubjectLocatorSource,
} from "./in-memory-observability-repository.js";

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

  advanceMs(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
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

export interface LoggedLine {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

export class RecordingLogger implements Logger {
  readonly lines: LoggedLine[] = [];

  constructor(private readonly bound: LogFields = {}) {}

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    this.lines.push({ level, message, fields: { ...this.bound, ...fields } });
  }

  child(fields: LogFields): Logger {
    const child = new RecordingLogger({ ...this.bound, ...fields });
    // Share the buffer so a test asserting on `context.logger.lines` still sees
    // what a scoped child emitted.
    Object.defineProperty(child, "lines", { value: this.lines });
    return child;
  }

  at(level: LogLevel): readonly LoggedLine[] {
    return this.lines.filter((line) => line.level === level);
  }
}

export const TEST_ORGANIZATION = "org-1";
export const TEST_PROJECT = "proj-1";
export const TEST_ENVIRONMENT = "env-1";

export function testScope(
  environmentId: string = TEST_ENVIRONMENT,
  organizationId: string = TEST_ORGANIZATION,
): EnvironmentScope {
  return environmentScope(
    asIdentifier(organizationId),
    asIdentifier(TEST_PROJECT),
    asIdentifier(environmentId),
  );
}

/** A well-formed envelope carrying whatever payload a test wants to try. */
export function testEnvelope(
  name: string,
  payload: unknown,
  options: { schemaVersion?: number; scope?: EnvironmentScope; eventId?: string } = {},
): DomainEvent {
  return {
    eventId: asIdentifier(options.eventId ?? "event-0001"),
    name,
    schemaVersion: options.schemaVersion ?? 1,
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    scope: options.scope ?? testScope(),
    requestId: null,
    payload: payload as never,
  };
}

/**
 * The `tenancy` handle is held opaquely and never called (see
 * `application/dependencies.ts`), so the double is deliberately uninhabited: any
 * call on it is a defect that fails loudly rather than a stub that passes.
 */
export const uncalledTenancy = undefined as unknown as TenancyContract;

export interface ObservabilityTestContext {
  readonly dependencies: ObservabilityDependencies;
  readonly sink: InMemoryObservabilitySink;
  readonly outbox: InMemoryProjectionOutbox;
  readonly repository: InMemoryObservabilityRepository;
  readonly erasedSubjects: InMemoryErasedSubjectRegister;
  readonly subjectLocators: InMemorySubjectLocatorSource;
  readonly clock: MutableClock;
  readonly ids: SequenceIdGenerator;
  readonly unitOfWork: ImmediateUnitOfWork;
  readonly logger: RecordingLogger;
}

export function buildObservabilityTestContext(
  budget: DrainBudget = DEFAULT_DRAIN_BUDGET,
): ObservabilityTestContext {
  const clock = new MutableClock();
  const sink = new InMemoryObservabilitySink();
  const outbox = new InMemoryProjectionOutbox();
  const repository = new InMemoryObservabilityRepository();
  const erasedSubjects = new InMemoryErasedSubjectRegister();
  const subjectLocators = new InMemorySubjectLocatorSource();
  const ids = new SequenceIdGenerator();
  const unitOfWork = new ImmediateUnitOfWork();
  const logger = new RecordingLogger();
  return {
    dependencies: Object.freeze({
      sink,
      outbox,
      repository,
      erasedSubjects,
      subjectLocators,
      clock,
      ids,
      unitOfWork,
      budget,
      logger,
      tenancy: uncalledTenancy,
    }),
    sink,
    outbox,
    repository,
    erasedSubjects,
    subjectLocators,
    clock,
    ids,
    unitOfWork,
    logger,
  };
}
