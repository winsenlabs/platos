// Deterministic doubles for the kernel ports, and one call that assembles the
// whole context in memory.
//
// `MutableClock` and `SequenceIdGenerator` are why every rule in this package is
// testable at an instant: nothing reads the wall clock and nothing mints a
// random id, so "this version was created ninety-one days ago" is
// `clock.advanceDays(...)` and "this is the third version" is a literal.
//
// AND THE CANARY DRAW IS AN ARGUMENT, NOT A GENERATOR. `domain/binding.ts`
// states why. The consequence here is that there is no random double to build:
// a test that wants the canary passes `0`, one that wants the active version
// passes `0.99`, and the boundary is a literal rather than a distribution.

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
import type { ProvidersContract } from "@platos/context-providers";
import type { TenancyContract } from "@platos/context-tenancy";

import {
  asAgentsIdentifier,
  buildSnapshot,
  DEFAULT_AGENTS_POLICY,
  DAY_MS,
  type ActorId,
  type Agent,
  type AgentBinding,
  type AgentBindingId,
  type AgentCluster,
  type AgentClusterId,
  type AgentId,
  type AgentVersion,
  type AgentVersionId,
  type AgentsPolicy,
  type Macro,
  type MacroId,
  type PostmanTemplate,
  type PostmanTemplateId,
  type Slug,
} from "../../domain/index.js";
import type { AgentsDependencies } from "../dependencies.js";
import { InMemoryAgentsRepository } from "./in-memory-agents-repository.js";
import { InMemoryMacroRecorder, InMemoryScaffolding, InMemoryVersionLock } from "./in-memory-scaffolding.js";
import { InMemoryProviders, InMemorySkills, InMemoryTenancy } from "./in-memory-peers.js";

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
    this.current = new Date(this.current.getTime() + days * DAY_MS);
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

export interface AgentsTestContext {
  readonly dependencies: AgentsDependencies;
  readonly repository: InMemoryAgentsRepository;
  readonly scaffolding: InMemoryScaffolding;
  readonly versionLock: InMemoryVersionLock;
  readonly recorder: InMemoryMacroRecorder;
  readonly tenancy: InMemoryTenancy;
  readonly providers: InMemoryProviders;
  readonly skills: InMemorySkills;
  readonly clock: MutableClock;
  readonly ids: SequenceIdGenerator;
  readonly unitOfWork: ImmediateUnitOfWork;
  readonly scope: EnvironmentScope;
}

export interface AgentsTestOptions {
  readonly policy?: AgentsPolicy;
  readonly scope?: EnvironmentScope;
}

export function buildAgentsTestContext(options: AgentsTestOptions = {}): AgentsTestContext {
  const scope = options.scope ?? testEnvironmentScope();
  const policy = options.policy ?? DEFAULT_AGENTS_POLICY;
  const clock = new MutableClock();
  const repository = new InMemoryAgentsRepository(policy);
  const scaffolding = new InMemoryScaffolding();
  const versionLock = new InMemoryVersionLock();
  const recorder = new InMemoryMacroRecorder();
  const tenancy = new InMemoryTenancy(scope);
  const providers = new InMemoryProviders(scope, () => clock.now());
  const skills = new InMemorySkills();
  const ids = new SequenceIdGenerator();
  const unitOfWork = new ImmediateUnitOfWork();

  return {
    dependencies: Object.freeze({
      repository,
      scaffolding,
      versionLock,
      recorder,
      clock,
      ids,
      unitOfWork,
      policy,
      tenancy: tenancy as unknown as TenancyContract,
      providers: providers as unknown as ProvidersContract,
      skills,
    }),
    repository,
    scaffolding,
    versionLock,
    recorder,
    tenancy,
    providers,
    skills,
    clock,
    ids,
    unitOfWork,
    scope,
  };
}

const EPOCH = new Date("2026-01-01T00:00:00.000Z");

/** A ready-made Agent row, for tests that need one to already exist. */
export function testAgent(scope: EnvironmentScope, overrides: Partial<Agent> = {}): Agent {
  return {
    agentId: asAgentsIdentifier<AgentId>("agent-1"),
    projectId: scope.projectId,
    name: "Support",
    slug: asAgentsIdentifier<Slug>("support"),
    description: null,
    isActive: true,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  };
}

/** A ready-made AgentVersion, snapshot built through the real defaults. */
export function testVersion(
  agentId: AgentId,
  overrides: Partial<AgentVersion> = {},
  source: Parameters<typeof buildSnapshot>[0] = {},
): AgentVersion {
  return {
    agentVersionId: asAgentsIdentifier<AgentVersionId>("version-1"),
    agentId,
    versionNumber: 1,
    toolDefaultPolicy: "ALL",
    note: "Initial version",
    createdBy: asAgentsIdentifier<ActorId>("operator-1"),
    createdAt: EPOCH,
    snapshot: buildSnapshot(source, DEFAULT_AGENTS_POLICY.defaults),
    ...overrides,
  };
}

export function testBinding(
  scope: EnvironmentScope,
  agentId: AgentId,
  activeVersionId: AgentVersionId,
  overrides: Partial<AgentBinding> = {},
): AgentBinding {
  return {
    agentBindingId: asAgentsIdentifier<AgentBindingId>("binding-1"),
    environmentId: scope.environmentId,
    agentId,
    activeVersionId,
    canaryVersionId: null,
    clusterId: null,
    canaryPercent: 0,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  };
}

export function testCluster(
  scope: EnvironmentScope,
  overrides: Partial<AgentCluster> = {},
): AgentCluster {
  return {
    clusterId: asAgentsIdentifier<AgentClusterId>("cluster-1"),
    environmentId: scope.environmentId,
    name: "Frontline",
    slug: asAgentsIdentifier<Slug>("frontline"),
    description: null,
    metadata: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  };
}

export function testMacro(scope: EnvironmentScope, overrides: Partial<Macro> = {}): Macro {
  return {
    macroId: asAgentsIdentifier<MacroId>("macro-1"),
    environmentId: scope.environmentId,
    name: "Weekly digest",
    description: null,
    steps: [{ tool: "mail.send", params: { to: "${user.email}" } }],
    paramSchema: null,
    sharedWithOrganization: false,
    createdBy: asAgentsIdentifier<ActorId>("operator-1"),
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  };
}

export function testTemplate(
  scope: EnvironmentScope,
  agentId: AgentId,
  overrides: Partial<PostmanTemplate> = {},
): PostmanTemplate {
  return {
    templateId: asAgentsIdentifier<PostmanTemplateId>("template-1"),
    environmentId: scope.environmentId,
    agentId,
    name: "Smoke",
    simulateUserId: "end-user-1",
    sessionContext: null,
    isDefault: false,
    createdBy: asAgentsIdentifier<ActorId>("operator-1"),
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  };
}

/**
 * Seed one bound agent — row, version and binding — and hand back all three.
 *
 * The shape almost every use-case test starts from, so it is one call rather
 * than three that a test could get subtly out of step with each other.
 */
export function seedBoundAgent(
  context: AgentsTestContext,
  overrides: {
    readonly agent?: Partial<Agent>;
    readonly version?: Partial<AgentVersion>;
    readonly binding?: Partial<AgentBinding>;
    readonly source?: Parameters<typeof buildSnapshot>[0];
  } = {},
): { readonly agent: Agent; readonly version: AgentVersion; readonly binding: AgentBinding } {
  const agent = context.repository.seedAgent(testAgent(context.scope, overrides.agent));
  const version = context.repository.seedVersion(
    testVersion(agent.agentId, overrides.version, overrides.source),
  );
  const binding = context.repository.seedBinding(
    testBinding(context.scope, agent.agentId, version.agentVersionId, overrides.binding),
  );
  return { agent, version, binding };
}
