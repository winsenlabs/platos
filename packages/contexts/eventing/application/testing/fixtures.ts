// Deterministic doubles for the kernel ports, and one call that assembles the
// whole context in memory.
//
// `MutableClock` and `SequenceIdGenerator` are why every rule in this package is
// testable at an instant: nothing reads the wall clock and nothing mints a
// random id, so "the retry is due two seconds from now" is arithmetic on a
// literal and "this is the third rule" is a literal.

import {
  asIdentifier,
  environmentScope,
  type Clock,
  type DomainEvent,
  type EnvironmentScope,
  type EventId,
  type IdGenerator,
  type JsonValue,
  type PrincipalId,
  type TransactionScope,
  type Ulid,
  type UnitOfWork,
  type Uuid,
} from "@platos/kernel";
import type { TenancyContract } from "@platos/context-tenancy";

import type { EventingDependencies } from "../dependencies.js";
import { InMemoryNotificationQueue, ScriptedDestinationScreen } from "./in-memory-queue.js";
import { InMemoryNotificationRuleRepository } from "./in-memory-rule-repository.js";

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

export function testEnvironmentScope(environmentId = "env-1"): EnvironmentScope {
  return environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier(environmentId));
}

export const TEST_PRINCIPAL = asIdentifier<PrincipalId>("user-1");

/** One outbox envelope, with the subject on the reserved payload key. */
export function testDomainEvent(options: {
  readonly name: string;
  readonly scope?: EnvironmentScope;
  readonly subjectId?: string | null;
  readonly eventId?: string;
  readonly payload?: Record<string, JsonValue>;
  readonly occurredAt?: Date;
}): DomainEvent {
  const subject = options.subjectId ?? null;
  return {
    eventId: asIdentifier<EventId>(options.eventId ?? "evt-1"),
    name: options.name,
    schemaVersion: 1,
    occurredAt: options.occurredAt ?? new Date("2026-01-01T00:00:00.000Z"),
    scope: options.scope ?? testEnvironmentScope(),
    requestId: null,
    payload: { ...(options.payload ?? {}), ...(subject === null ? {} : { subjectId: subject }) },
  };
}

/**
 * The `tenancy` handle is held opaquely and never called (see
 * `application/dependencies.ts`), so the double is deliberately uninhabited: any
 * call on it is a defect that fails loudly rather than a stub that passes.
 */
export const uncalledTenancy = undefined as unknown as TenancyContract;

export interface EventingTestContext {
  readonly dependencies: EventingDependencies;
  readonly repository: InMemoryNotificationRuleRepository;
  readonly queue: InMemoryNotificationQueue;
  readonly screen: ScriptedDestinationScreen;
  readonly clock: MutableClock;
  readonly ids: SequenceIdGenerator;
  readonly unitOfWork: ImmediateUnitOfWork;
}

export function buildEventingTestContext(): EventingTestContext {
  const clock = new MutableClock();
  const repository = new InMemoryNotificationRuleRepository();
  const queue = new InMemoryNotificationQueue();
  const screen = new ScriptedDestinationScreen();
  const ids = new SequenceIdGenerator();
  const unitOfWork = new ImmediateUnitOfWork();
  return {
    dependencies: Object.freeze({
      repository,
      screen,
      queue,
      clock,
      ids,
      unitOfWork,
      tenancy: uncalledTenancy,
    }),
    repository,
    queue,
    screen,
    clock,
    ids,
    unitOfWork,
  };
}
