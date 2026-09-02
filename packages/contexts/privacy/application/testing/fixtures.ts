// Deterministic doubles for the kernel ports, the three driven ports this
// context owns, and one call that assembles the whole context in memory.
//
// `MutableClock` and `SequenceIdGenerator` are why every rule in this package is
// testable at an instant: nothing reads the wall clock and nothing mints a
// random id, so "the tombstone has lapsed" is `clock.advanceSeconds(...)` and
// "the third operation" is a literal. This context's rules are almost entirely
// about instants — expiry, backoff, leases — so that matters more here than
// anywhere else.
//
// `HashingSubjectHasher` is a REAL, deterministic, salted digest rather than an
// identity function. An identity double would make every content-free test
// vacuous: the guard searches a payload for the subject's handles, and a
// "digest" that IS the handle would trip it on every call, so the tests would
// have to stop asserting the property they exist to assert.

import {
  asIdentifier,
  domainError,
  environmentScope,
  err,
  ok,
  organizationScope,
  type Clock,
  type ErasureSubject,
  type ErasureTarget,
  type EventId,
  type IdGenerator,
  type JsonValue,
  type OrganizationId,
  type OutboxWriter,
  type Result,
  type TransactionScope,
  type Ulid,
  type UnitOfWork,
  type Uuid,
} from "@platos/kernel";
import type { DomainEventDraft } from "@platos/kernel";
import type { TenancyContract } from "@platos/context-tenancy";

import {
  DEFAULT_PRIVACY_POLICY,
  canonicalAlias,
  subjectAlias,
  type PrivacyPolicy,
  type SubjectAlias,
} from "../../domain/index.js";
import type { PrivacyDependencies } from "../dependencies.js";
import type { LegalHoldRegister, SubjectDirectory, SubjectHasher } from "../ports/index.js";
import { InMemoryErasureTarget } from "./in-memory-erasure-target.js";
import { InMemoryPrivacyRepository } from "./in-memory-privacy-repository.js";

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

  advanceDays(days: number): void {
    this.advanceSeconds(days * 24 * 60 * 60);
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

/**
 * Runs the work with a stable handle, and ROLLS BACK when it rejects.
 *
 * The rollback is simulated by the participants rather than by this class: each
 * double records what it did per transaction and undoes it here. That is the
 * only way the "a rolled-back pass certifies nothing" rule is provable in
 * memory, and it is why this is not the same double the leaf contexts use.
 */
export class RollbackAwareUnitOfWork implements UnitOfWork {
  private counter = 0;
  readonly committed: TransactionScope[] = [];
  readonly rolledBack: TransactionScope[] = [];
  readonly onRollback: ((transaction: TransactionScope) => void)[] = [];

  async run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
    this.counter += 1;
    const transaction: TransactionScope = { transactionId: asIdentifier(`txn-${this.counter}`) };
    try {
      const value = await work(transaction);
      this.committed.push(transaction);
      return value;
    } catch (error) {
      this.rolledBack.push(transaction);
      for (const undo of this.onRollback) undo(transaction);
      throw error;
    }
  }
}

/** Records every appended event, so an assertion can read the audit trail. */
export class RecordingOutboxWriter implements OutboxWriter {
  readonly appended: DomainEventDraft<JsonValue>[] = [];
  private counter = 0;

  async append<Payload extends JsonValue>(
    event: DomainEventDraft<Payload>,
    _transaction: TransactionScope,
  ): Promise<EventId> {
    this.appended.push(event as DomainEventDraft<JsonValue>);
    this.counter += 1;
    return asIdentifier<EventId>(`evt-${this.counter}`);
  }

  names(): readonly string[] {
    return this.appended.map((event) => event.name);
  }
}

/** A real salted digest. See the note at the top of this file. */
export class HashingSubjectHasher implements SubjectHasher {
  constructor(private readonly salt = "test-salt") {}

  digest(input: string): string {
    // FNV-1a over the salted input. Not cryptographic, and deliberately not
    // pretending to be: what a test needs from this port is determinism, a
    // dependence on the salt, and an output that shares no substring with its
    // input. A real adapter uses SHA-256.
    let hash = 0x81_1c_9d_c5;
    const salted = `${this.salt}${String.fromCharCode(0)}${input}`;
    for (let index = 0; index < salted.length; index += 1) {
      hash ^= salted.charCodeAt(index);
      hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
    }
    return `d${hash.toString(16).padStart(8, "0")}`;
  }
}

/** A directory whose answers are arranged per external id. */
export class StubSubjectDirectory implements SubjectDirectory {
  private readonly answers = new Map<string, { subjects: ErasureSubject[]; aliases: SubjectAlias[] }>();

  fails = false;

  register(
    externalUserId: string,
    answer: { readonly subjects: readonly ErasureSubject[]; readonly aliases: readonly SubjectAlias[] },
  ): void {
    this.answers.set(externalUserId, { subjects: [...answer.subjects], aliases: [...answer.aliases] });
  }

  async resolve(query: {
    readonly organizationId: OrganizationId;
    readonly externalUserId: string;
  }): Promise<Result<{ subjects: readonly ErasureSubject[]; aliases: readonly SubjectAlias[] }>> {
    if (this.fails) return err(domainError("TEST_DIRECTORY_DOWN", "unavailable", "directory is down"));
    const found = this.answers.get(query.externalUserId);
    return ok(found ?? { subjects: [], aliases: [] });
  }
}

/** A hold register backed by a list an assertion can rewrite between calls. */
export class StubLegalHoldRegister implements LegalHoldRegister {
  entriesByOrganization = new Map<string, readonly string[]>();
  fails = false;

  set(organizationId: OrganizationId, entries: readonly string[]): void {
    this.entriesByOrganization.set(organizationId, entries);
  }

  async entries(organizationId: OrganizationId): Promise<Result<readonly string[]>> {
    if (this.fails) return err(domainError("TEST_REGISTER_DOWN", "unavailable", "register is down"));
    return ok(this.entriesByOrganization.get(organizationId) ?? []);
  }
}

export const TEST_ORGANIZATION: OrganizationId = asIdentifier("org-1");

export function testEnvironmentSubject(
  subjectId: string,
  environmentId = "env-1",
  subjectKind: ErasureSubject["subjectKind"] = "end-user",
): ErasureSubject {
  return {
    subjectKind,
    subjectId,
    scope: environmentScope(TEST_ORGANIZATION, asIdentifier("proj-1"), asIdentifier(environmentId)),
  };
}

export function testOrganizationScope() {
  return organizationScope(TEST_ORGANIZATION);
}

export function testAliases(externalUserId: string, endUserId: string): readonly SubjectAlias[] {
  return [
    subjectAlias("external", externalUserId),
    subjectAlias("email", `${externalUserId}@example.com`),
    canonicalAlias(endUserId),
  ];
}

/**
 * The `tenancy` handle is held opaquely and never called (see
 * `application/dependencies.ts`), so the double is deliberately uninhabited: any
 * call on it is a defect that fails loudly rather than a stub that passes.
 */
export const uncalledTenancy = undefined as unknown as TenancyContract;

export interface PrivacyTestContext {
  readonly dependencies: PrivacyDependencies;
  readonly repository: InMemoryPrivacyRepository;
  readonly directory: StubSubjectDirectory;
  readonly holds: StubLegalHoldRegister;
  readonly hasher: HashingSubjectHasher;
  readonly outbox: RecordingOutboxWriter;
  readonly clock: MutableClock;
  readonly ids: SequenceIdGenerator;
  readonly unitOfWork: RollbackAwareUnitOfWork;
  readonly targets: readonly InMemoryErasureTarget[];
}

export function buildPrivacyTestContext(
  options: {
    readonly targets?: readonly InMemoryErasureTarget[];
    readonly policy?: PrivacyPolicy;
  } = {},
): PrivacyTestContext {
  const clock = new MutableClock();
  const repository = new InMemoryPrivacyRepository();
  const directory = new StubSubjectDirectory();
  const holds = new StubLegalHoldRegister();
  const hasher = new HashingSubjectHasher();
  const outbox = new RecordingOutboxWriter();
  const ids = new SequenceIdGenerator();
  const unitOfWork = new RollbackAwareUnitOfWork();
  const targets = options.targets ?? [new InMemoryErasureTarget("files")];
  // The targets participate in the rollback, so a discarded destructive
  // transaction really does restore their rows. See `RollbackAwareUnitOfWork`.
  unitOfWork.onRollback.push((transaction) => {
    for (const target of targets) target.rollback(transaction);
  });
  return {
    dependencies: Object.freeze({
      repository,
      directory,
      hasher,
      holds,
      targets: targets as readonly ErasureTarget[],
      clock,
      ids,
      unitOfWork,
      outbox,
      policy: options.policy ?? DEFAULT_PRIVACY_POLICY,
      tenancy: uncalledTenancy,
    }),
    repository,
    directory,
    holds,
    hasher,
    outbox,
    clock,
    ids,
    unitOfWork,
    targets,
  };
}
