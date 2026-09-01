// Deterministic doubles for the kernel ports, and one call that assembles the
// whole context in memory.
//
// `MutableClock` and `SequenceIdGenerator` are why every rule in this package is
// testable at an instant: nothing reads the wall clock and nothing mints a
// random id, so "the grant has expired" is `clock.advance(...)` and "this is the
// third attachment" is a literal.

import {
  asIdentifier,
  environmentScope,
  type Clock,
  type IdGenerator,
  type TransactionScope,
  type Ulid,
  type UnitOfWork,
  type Uuid,
} from "@platos/kernel";
import type { TenancyContract } from "@platos/context-tenancy";

import {
  attachmentScope,
  DEFAULT_FILES_POLICY,
  threadScope,
  type AgentId,
  type AttachmentScope,
  type EndUserId,
  type FilesPolicy,
  type ThreadId,
  type ThreadScope,
} from "../../domain/index.js";
import type { FilesDependencies } from "../dependencies.js";
import { InMemoryFilesRepository } from "./in-memory-files-repository.js";
import { InMemoryObjectStore } from "./in-memory-object-store.js";

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

export function testThreadScope(environmentId: string, threadId = "thread-1"): ThreadScope {
  return threadScope(
    environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier(environmentId)),
    asIdentifier<ThreadId>(threadId),
  );
}

export function testAttachmentScope(environmentId: string, threadId = "thread-1"): AttachmentScope {
  return attachmentScope(testThreadScope(environmentId, threadId), {
    endUserId: asIdentifier<EndUserId>("end-user-1"),
    agentId: asIdentifier<AgentId>("agent-1"),
  });
}

/**
 * The `tenancy` handle is held opaquely and never called (see
 * `application/dependencies.ts`), so the double is deliberately uninhabited: any
 * call on it is a defect that fails loudly rather than a stub that passes.
 */
export const uncalledTenancy = undefined as unknown as TenancyContract;

export interface FilesTestContext {
  readonly dependencies: FilesDependencies;
  readonly repository: InMemoryFilesRepository;
  readonly objectStore: InMemoryObjectStore;
  readonly clock: MutableClock;
  readonly ids: SequenceIdGenerator;
  readonly unitOfWork: ImmediateUnitOfWork;
}

export function buildFilesTestContext(policy: FilesPolicy = DEFAULT_FILES_POLICY): FilesTestContext {
  const clock = new MutableClock();
  const repository = new InMemoryFilesRepository();
  const objectStore = new InMemoryObjectStore({ now: () => clock.now() });
  const ids = new SequenceIdGenerator();
  const unitOfWork = new ImmediateUnitOfWork();
  return {
    dependencies: Object.freeze({
      repository,
      objectStore,
      clock,
      ids,
      unitOfWork,
      policy,
      tenancy: uncalledTenancy,
    }),
    repository,
    objectStore,
    clock,
    ids,
    unitOfWork,
  };
}
