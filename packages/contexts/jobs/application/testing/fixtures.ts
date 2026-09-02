// Deterministic doubles for the kernel ports, and one call that assembles the
// whole context in memory.
//
// `MutableClock` and `SequenceIdGenerator` are why every rule in this package is
// testable at an instant: nothing reads the wall clock and nothing mints a random
// id, so "the approval deadline has passed" is `clock.advanceSeconds(...)` and
// "this is the third approval" is a literal.
//
// `countingDigest` is a REAL hash in the sense that matters here — equal inputs
// give equal outputs and different inputs give different outputs — without
// pulling in a crypto implementation this layer is forbidden to name. Tests
// assert digest EQUALITY and INEQUALITY, never a specific SHA-256 value, so a
// stand-in is not a weakening.

import {
  asIdentifier,
  environmentScope,
  type Clock,
  type EnvironmentScope,
  type IdGenerator,
  type TransactionScope,
  type Ulid,
  type UnitOfWork,
  type Uuid,
} from "@platos/kernel";
import type { TenancyContract } from "@platos/context-tenancy";

import type { DigestFunction } from "../../domain/index.js";
import type { JobsDependencies } from "../dependencies.js";
import { InMemoryApprovalsRepository } from "./in-memory-approvals-repository.js";
import {
  InMemoryIdempotencyStore,
  RecordingDurableRuntime,
  ScriptedJobHandlerRuntime,
} from "./in-memory-infrastructure.js";
import { InMemoryJobsRepository } from "./in-memory-jobs-repository.js";

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

  advanceMilliseconds(milliseconds: number): void {
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

/**
 * An injective, deterministic stand-in for SHA-256: it echoes its input under a
 * prefix. Collision-resistance is irrelevant to the properties tested here and
 * an echo makes a failing assertion readable.
 */
export const echoDigest: DigestFunction = (input: string) => `digest(${input})`;

export function testEnvironmentScope(environmentId = "env-1"): EnvironmentScope {
  return environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier(environmentId));
}

/**
 * The `tenancy` handle is held opaquely and never called (see
 * `application/dependencies.ts`), so the double is deliberately uninhabited: any
 * call on it is a defect that fails loudly rather than a stub that passes.
 */
export const uncalledTenancy = undefined as unknown as TenancyContract;

export interface JobsTestContext {
  readonly dependencies: JobsDependencies;
  readonly jobs: InMemoryJobsRepository;
  readonly approvals: InMemoryApprovalsRepository;
  readonly idempotency: InMemoryIdempotencyStore;
  readonly handlers: ScriptedJobHandlerRuntime;
  readonly durableRuntime: RecordingDurableRuntime;
  readonly clock: MutableClock;
  readonly ids: SequenceIdGenerator;
  readonly unitOfWork: ImmediateUnitOfWork;
}

export function buildJobsTestContext(knownSecrets: readonly string[] = []): JobsTestContext {
  const clock = new MutableClock();
  const jobs = new InMemoryJobsRepository();
  const approvals = new InMemoryApprovalsRepository();
  const idempotency = new InMemoryIdempotencyStore(() => clock.now());
  const handlers = new ScriptedJobHandlerRuntime();
  const durableRuntime = new RecordingDurableRuntime();
  const ids = new SequenceIdGenerator();
  const unitOfWork = new ImmediateUnitOfWork();
  return {
    dependencies: Object.freeze({
      jobs,
      approvals,
      idempotency,
      handlers,
      durableRuntime,
      clock,
      ids,
      unitOfWork,
      digest: echoDigest,
      knownSecrets,
      tenancy: uncalledTenancy,
    }),
    jobs,
    approvals,
    idempotency,
    handlers,
    durableRuntime,
    clock,
    ids,
    unitOfWork,
  };
}
