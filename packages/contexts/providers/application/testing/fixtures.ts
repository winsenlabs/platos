// Deterministic doubles for the kernel ports, and one call that assembles the
// whole context in memory.
//
// `MutableClock` and `SequenceIdGenerator` are why every rule in this package is
// testable at an instant: nothing reads the wall clock and nothing mints a
// random id, so "the cached liveness result has expired" is `clock.advance(...)`
// and "this is the third provider key" is a literal.

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
import type { SecretsContract } from "@platos/context-secrets";
import type { TenancyContract } from "@platos/context-tenancy";

import {
  asProvidersIdentifier,
  DEFAULT_PROVIDER_CATALOGUE,
  DEFAULT_PROVIDERS_POLICY,
  type ActorId,
  type CredentialName,
  type ProviderCatalogue,
  type ProviderId,
  type ProviderKey,
  type ProviderKeyId,
  type ProvidersPolicy,
} from "../../domain/index.js";
import type { ProvidersDependencies } from "../dependencies.js";
import { InMemoryModelRouter } from "./in-memory-model-router.js";
import { InMemoryProviderProbeCache } from "./in-memory-probe-cache.js";
import { InMemoryProvidersRepository } from "./in-memory-providers-repository.js";
import { InMemorySecrets, InMemoryTenancy } from "./in-memory-peers.js";

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

export interface ProvidersTestContext {
  readonly dependencies: ProvidersDependencies;
  readonly repository: InMemoryProvidersRepository;
  readonly modelRouter: InMemoryModelRouter;
  readonly probeCache: InMemoryProviderProbeCache;
  readonly secrets: InMemorySecrets;
  readonly tenancy: InMemoryTenancy;
  readonly clock: MutableClock;
  readonly ids: SequenceIdGenerator;
  readonly unitOfWork: ImmediateUnitOfWork;
  readonly scope: EnvironmentScope;
}

export interface ProvidersTestOptions {
  readonly policy?: ProvidersPolicy;
  readonly catalogue?: ProviderCatalogue;
  readonly scope?: EnvironmentScope;
}

export function buildProvidersTestContext(
  options: ProvidersTestOptions = {},
): ProvidersTestContext {
  const scope = options.scope ?? testEnvironmentScope();
  const clock = new MutableClock();
  const repository = new InMemoryProvidersRepository();
  const modelRouter = new InMemoryModelRouter();
  const probeCache = new InMemoryProviderProbeCache(() => clock.now());
  const secrets = new InMemorySecrets(scope, () => clock.now());
  const tenancy = new InMemoryTenancy(scope);
  const ids = new SequenceIdGenerator();
  const unitOfWork = new ImmediateUnitOfWork();

  return {
    dependencies: Object.freeze({
      repository,
      modelRouter,
      probeCache,
      clock,
      ids,
      unitOfWork,
      policy: options.policy ?? DEFAULT_PROVIDERS_POLICY,
      catalogue: options.catalogue ?? DEFAULT_PROVIDER_CATALOGUE,
      secrets: secrets as unknown as SecretsContract,
      tenancy: tenancy as unknown as TenancyContract,
    }),
    repository,
    modelRouter,
    probeCache,
    secrets,
    tenancy,
    clock,
    ids,
    unitOfWork,
    scope,
  };
}

/** A ready-made ProviderKey row, for tests that need one to already exist. */
export function testProviderKey(
  scope: EnvironmentScope,
  overrides: Partial<ProviderKey> = {},
): ProviderKey {
  const at = new Date("2026-01-01T00:00:00.000Z");
  return {
    providerKeyId: asProvidersIdentifier<ProviderKeyId>("key-1"),
    environmentId: scope.environmentId,
    credentialId: asIdentifier("cred-1"),
    provider: asProvidersIdentifier<ProviderId>("openai"),
    label: "production",
    credentialName: asProvidersIdentifier<CredentialName>("OPENAI_API_KEY"),
    isDefault: true,
    createdBy: asIdentifier<ActorId>("operator-1"),
    lastUsedAt: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}
