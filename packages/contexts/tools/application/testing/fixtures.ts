// Deterministic doubles for the kernel ports, and one call that assembles the
// whole context in memory.
//
// `MutableClock` and `SequenceIdGenerator` are why every rule in this package
// is testable at an instant: nothing reads the wall clock and nothing mints a
// random id, so "the health average after three calls" is a literal and "the
// audit row was written at the end" is an assertion rather than a hope.
//
// `CountingDigest` is the third. It is a FAKE digest — a stable, injective
// encoding rather than SHA-256 — and that is deliberate: `domain/tool.ts` owns
// the canonicalisation and `application/ports/content-digest.ts` owns the hash,
// so the tests that matter here are about whether two documents CANONICALISE
// the same, not about whether a hash function works. Using a real one would
// make every expected `schemaHash` in this package an opaque constant nobody
// could check by reading.

import {
  asIdentifier,
  environmentScope,
  type Clock,
  type EntityId,
  type EnvironmentScope,
  type IdGenerator,
  type TransactionScope,
  type Ulid,
  type UnitOfWork,
  type Uuid,
} from "@platos/kernel";
import type { IdentityAccessContract } from "@platos/context-identity-access";
import type { ProvidersContract } from "@platos/context-providers";
import type { SecretsContract } from "@platos/context-secrets";
import type { TenancyContract } from "@platos/context-tenancy";

import {
  asToolsIdentifier,
  DEFAULT_TOOLS_POLICY,
  type AgentId,
  type ExposureId,
  type ExternalEntityId,
  type ToolExposure,
  type ToolId,
  type ToolName,
  type ToolsPolicy,
} from "../../domain/index.js";
import type { ToolsDependencies } from "../dependencies.js";
import type { ContentDigest } from "../ports/index.js";
import { InMemoryToolDispatch } from "./in-memory-dispatch.js";
import {
  InMemoryIdentityAccess,
  InMemoryProviders,
  InMemorySecrets,
  InMemoryTenancy,
} from "./in-memory-peers.js";
import { InMemoryToolsRepository } from "./in-memory-tools-repository.js";

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

/**
 * A readable stand-in for SHA-256.
 *
 * Lowercase hex and the full width a digest has, so it satisfies `toSchemaHash`;
 * injective over its inputs, so two different canonical documents cannot
 * collide and make a test pass for the wrong reason.
 *
 * THE COUNTER IS PADDED ON THE RIGHT, NOT THE LEFT, AND THAT IS LOAD-BEARING.
 * `Tool.schemaHash` is the FIRST sixteen characters of the digest, so a
 * left-padded counter would make every digest identical after truncation — and
 * every "a changed shape mints a new row" test would pass for the wrong reason,
 * against a double that had silently made every tool one tool.
 */
export class CountingDigest implements ContentDigest {
  private readonly seen = new Map<string, string>();
  /** Every string that was hashed, in order. */
  readonly inputs: string[] = [];

  sha256Hex(input: string): string {
    this.inputs.push(input);
    const held = this.seen.get(input);
    if (held !== undefined) return held;
    const digest = (this.seen.size + 1).toString(16).padEnd(64, "0");
    this.seen.set(input, digest);
    return digest;
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

export interface ToolsTestContext {
  readonly dependencies: ToolsDependencies;
  readonly repository: InMemoryToolsRepository;
  readonly dispatch: InMemoryToolDispatch;
  readonly digest: CountingDigest;
  readonly tenancy: InMemoryTenancy;
  readonly identityAccess: InMemoryIdentityAccess;
  readonly secrets: InMemorySecrets;
  readonly clock: MutableClock;
  readonly ids: SequenceIdGenerator;
  readonly unitOfWork: ImmediateUnitOfWork;
  readonly scope: EnvironmentScope;
}

export interface ToolsTestOptions {
  readonly policy?: ToolsPolicy;
  readonly scope?: EnvironmentScope;
}

export function buildToolsTestContext(options: ToolsTestOptions = {}): ToolsTestContext {
  const scope = options.scope ?? testEnvironmentScope();
  const clock = new MutableClock();
  const repository = new InMemoryToolsRepository(scope);
  const dispatch = new InMemoryToolDispatch();
  const digest = new CountingDigest();
  const tenancy = new InMemoryTenancy(scope);
  const identityAccess = new InMemoryIdentityAccess();
  const secrets = new InMemorySecrets();
  const providers = new InMemoryProviders();
  const ids = new SequenceIdGenerator();
  const unitOfWork = new ImmediateUnitOfWork();

  return {
    dependencies: Object.freeze({
      repository,
      dispatch,
      digest,
      clock,
      ids,
      unitOfWork,
      policy: options.policy ?? DEFAULT_TOOLS_POLICY,
      tenancy: tenancy as unknown as TenancyContract,
      identityAccess: identityAccess as unknown as IdentityAccessContract,
      secrets: secrets as unknown as SecretsContract,
      providers: providers as unknown as ProvidersContract,
    }),
    repository,
    dispatch,
    digest,
    tenancy,
    identityAccess,
    secrets,
    clock,
    ids,
    unitOfWork,
    scope,
  };
}

/** A ready-made exposure, for tests that need the matrix to already hold one. */
export function testExposure(
  scope: EnvironmentScope,
  overrides: Partial<ToolExposure> = {},
): ToolExposure {
  return {
    exposureId: asToolsIdentifier<ExposureId>("exposure-1"),
    environmentId: scope.environmentId,
    entityId: asIdentifier<EntityId>("entity-pk-1"),
    externalEntityId: asToolsIdentifier<ExternalEntityId>("acme-backend"),
    toolId: asToolsIdentifier<ToolId>("tool-1"),
    toolName: asToolsIdentifier<ToolName>("files.upload"),
    description: "upload a file to the customer's store",
    paramSchema: { properties: { path: { type: "string" } } },
    category: "files",
    callbackUrl: "https://acme.test/tools",
    connectionKind: "wire",
    enabled: true,
    dispatchable: true,
    allowedAgentIds: [asToolsIdentifier<AgentId>("agent-1")],
    injectMcpContext: false,
    ...overrides,
  };
}
