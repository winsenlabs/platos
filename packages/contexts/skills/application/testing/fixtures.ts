// Deterministic doubles for the kernel ports and this context's three
// non-repository ports, and one call that assembles the whole context in memory.
//
// `MutableClock` and `SequenceIdGenerator` are why every rule in this package is
// testable at an instant: nothing reads the wall clock and nothing mints a
// random id, so "this row was stamped later" is `clock.advanceSeconds(...)` and
// "this is the third skill" is a literal.
//
// The three doubles below are each REAL enough to be wrong in the ways their
// adapters can be wrong — a directory that reports absence, a fetcher that
// refuses or truncates, a sandbox that fails. A double that can only succeed
// leaves every failure branch in the use cases unexecuted.

import {
  asIdentifier,
  err,
  ok,
  type Clock,
  type EnvironmentScope,
  type IdGenerator,
  type JsonValue,
  type Result,
  type TransactionScope,
  type Ulid,
  type UnitOfWork,
  type Uuid,
} from "@platos/kernel";
import type { FilesContract } from "@platos/context-files";
import type { TenancyContract } from "@platos/context-tenancy";

import {
  DEFAULT_SKILLS_POLICY,
  sandboxUnavailable,
  sourceFetchFailed,
  sourceTooLarge,
  type EnvironmentKey,
  type EnvironmentKeyPresence,
  type EnvironmentSkillId,
  type ProjectSkillId,
  type SkillId,
  type SkillsPolicy,
} from "../../domain/index.js";
import type { SkillsDependencies } from "../dependencies.js";
import type {
  EnvironmentKeyDirectory,
  SkillSandbox,
  SkillSandboxOutcome,
  SkillSandboxRequest,
  SkillSourceDocument,
  SkillSourceFetcher,
  SkillSourceRequest,
} from "../ports/index.js";
import { InMemorySkillsRepository } from "./in-memory-skills-repository.js";

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

/**
 * A directory over a set of names that are SET.
 *
 * Answers `false` for every key it was asked about and does not hold, never
 * omitting it — the port requires an entry per queried key, and a double that
 * omitted them would let a use case that reads a missing key as "set" pass.
 */
export class InMemoryEnvironmentKeyDirectory implements EnvironmentKeyDirectory {
  private readonly set = new Set<string>();
  private failure: string | null = null;
  readonly queries: (readonly EnvironmentKey[])[] = [];

  constructor(keys: readonly string[] = []) {
    for (const key of keys) this.set.add(key);
  }

  setKey(key: string): void {
    this.set.add(key);
  }

  unsetKey(key: string): void {
    this.set.delete(key);
  }

  failNext(reason: string): void {
    this.failure = reason;
  }

  async presenceOf(
    _scope: EnvironmentScope,
    keys: readonly EnvironmentKey[],
  ): Promise<Result<EnvironmentKeyPresence>> {
    this.queries.push(keys);
    if (this.failure !== null) {
      const reason = this.failure;
      this.failure = null;
      // An outage is a failure, never an empty map: an empty map reads as
      // "nothing is set" and would disable every skill in the environment.
      return err(sourceFetchFailed(reason, null));
    }
    const presence: Record<string, boolean> = {};
    for (const key of keys) presence[key] = this.set.has(key);
    return ok(presence);
  }
}

/** A fetcher over a fixed map of URL to body. */
export class InMemorySkillSourceFetcher implements SkillSourceFetcher {
  private readonly bodies = new Map<string, string>();
  private readonly redirects = new Map<string, string>();
  readonly requests: SkillSourceRequest[] = [];

  put(url: string, body: string): void {
    this.bodies.set(url, body);
  }

  /** Make `from` resolve to `to`, so provenance-vs-resolution can be exercised. */
  redirect(from: string, to: string): void {
    this.redirects.set(from, to);
  }

  async fetch(request: SkillSourceRequest): Promise<Result<SkillSourceDocument>> {
    this.requests.push(request);
    const resolvedUrl = this.redirects.get(request.url) ?? request.url;
    const body = this.bodies.get(resolvedUrl);
    if (body === undefined) return err(sourceFetchFailed(request.url, 404));
    const bytes = new TextEncoder().encode(body).length;
    // Enforced while "reading", as the port's contract requires: an oversized
    // body is refused rather than returned for the caller to measure.
    if (bytes > request.maxBytes) return err(sourceTooLarge(bytes, request.maxBytes));
    return ok({ resolvedUrl, body, bytes });
  }
}

/** A sandbox that answers from a fixed table, keyed by handler. */
export class InMemorySkillSandbox implements SkillSandbox {
  private readonly results = new Map<string, JsonValue>();
  private failure: string | null = null;
  readonly runs: SkillSandboxRequest[] = [];

  put(handler: string, result: JsonValue): void {
    this.results.set(handler, result);
  }

  failNext(reason: string): void {
    this.failure = reason;
  }

  async run(request: SkillSandboxRequest): Promise<Result<SkillSandboxOutcome>> {
    this.runs.push(request);
    if (this.failure !== null) {
      const reason = this.failure;
      this.failure = null;
      return err(sandboxUnavailable(reason));
    }
    const result = this.results.get(request.handler);
    if (result === undefined) return err(sandboxUnavailable(`no handler ${request.handler}`));
    return ok({
      result,
      // `costCents` null is "unknown", never "free". A double that reported 0
      // would let a caller that conflates the two look correct.
      usage: { inputUnits: null, outputUnits: null, costCents: null, latencyMillis: 0 },
    });
  }
}

/**
 * The `tenancy` and `files` handles are held opaquely and never called (see
 * `application/dependencies.ts`), so the doubles are deliberately uninhabited:
 * any call on one is a defect that fails loudly rather than a stub that passes.
 */
export const uncalledTenancy = undefined as unknown as TenancyContract;
export const uncalledFiles = undefined as unknown as FilesContract;

export interface SkillsTestContext {
  readonly dependencies: SkillsDependencies;
  readonly repository: InMemorySkillsRepository;
  readonly environmentKeys: InMemoryEnvironmentKeyDirectory;
  readonly sourceFetcher: InMemorySkillSourceFetcher;
  readonly sandbox: InMemorySkillSandbox;
  readonly clock: MutableClock;
  readonly ids: SequenceIdGenerator;
  readonly unitOfWork: ImmediateUnitOfWork;
}

export function buildSkillsTestContext(policy: SkillsPolicy = DEFAULT_SKILLS_POLICY): SkillsTestContext {
  const clock = new MutableClock();
  const ids = new SequenceIdGenerator();
  const repository = new InMemorySkillsRepository({
    now: () => clock.now(),
    skillId: () => asIdentifier<SkillId>(ids.uuid()),
    projectSkillId: () => asIdentifier<ProjectSkillId>(ids.uuid()),
    environmentSkillId: () => asIdentifier<EnvironmentSkillId>(ids.uuid()),
  });
  const environmentKeys = new InMemoryEnvironmentKeyDirectory();
  const sourceFetcher = new InMemorySkillSourceFetcher();
  const sandbox = new InMemorySkillSandbox();
  const unitOfWork = new ImmediateUnitOfWork();
  return {
    dependencies: Object.freeze({
      repository,
      sourceFetcher,
      environmentKeys,
      sandbox,
      clock,
      ids,
      unitOfWork,
      policy,
      tenancy: uncalledTenancy,
      files: uncalledFiles,
    }),
    repository,
    environmentKeys,
    sourceFetcher,
    sandbox,
    clock,
    ids,
    unitOfWork,
  };
}
