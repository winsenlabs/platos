// Builders for the values this context's tests are written against.
//
// Every one takes an overrides object and fills the rest with a value that is
// VALID rather than empty, so a test states only the field it is about. A test
// that has to spell out twenty-six columns to say "an archived memory" is a test
// nobody reads.
//
// TIME AND IDENTITY ARE FIXED HERE. `FIXED_NOW` is the instant every builder
// dates from and `stepClock` advances by a stated amount, so a test about a
// throttle window says `stepClock(HOUR)` rather than sleeping. The id generator
// counts, so `mem-1`, `mem-2` are the ids in a failure message rather than
// thirty-six random characters.

import {
  asIdentifier,
  environmentScope,
  type Clock,
  type EnvironmentId,
  type EnvironmentScope,
  type IdGenerator,
  type OrganizationId,
  type ProjectId,
  type Ulid,
  type UnitOfWork,
  type Uuid,
} from "@platos/kernel";

import {
  authorizeMemoryRuntime,
  DEFAULT_MEMORY_POLICY,
  memorySubject,
  NO_CONFIDENCE,
  NO_PROVENANCE,
  type ActorId,
  type AgentBinding,
  type AgentId,
  type ClusterId,
  type EndUserId,
  type EntityKey,
  type Memory,
  type MemoryEntity,
  type MemoryEntityId,
  type MemoryId,
  type MemoryPolicy,
  type MemoryRelationship,
  type MemoryRelationshipId,
  type MemoryRuntimeAuthorization,
  type MemorySubject,
  type ThreadId,
  type TranscriptTurn,
  type TurnId,
} from "../../domain/index.js";
import type { MemoryDependencies } from "../dependencies.js";
import { InMemoryCache } from "./in-memory-cache.js";
import { InMemoryEmbeddingModel } from "./in-memory-embedding-model.js";
import { InMemoryExtractionJudge } from "./in-memory-judge.js";
import { InMemoryKnowledgeGraphRepository } from "./in-memory-knowledge-graph-repository.js";
import { InMemoryMemoryRepository } from "./in-memory-memory-repository.js";
import { InMemoryProviders, InMemoryTenancy } from "./in-memory-peers.js";
import { countingDigest } from "./counting-digest.js";

export const FIXED_NOW = new Date("2026-09-03T12:00:00.000Z");
export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const ORGANIZATION = asIdentifier<OrganizationId>("org-1");
export const PROJECT = asIdentifier<ProjectId>("proj-1");
export const ENVIRONMENT = asIdentifier<EnvironmentId>("env-1");

export const ENVIRONMENT_SCOPE: EnvironmentScope = environmentScope(ORGANIZATION, PROJECT, ENVIRONMENT);

export const SUBJECT_ID = asIdentifier<EndUserId>("user-1");
export const AGENT = asIdentifier<AgentId>("agent-1");
export const PEER_AGENT = asIdentifier<AgentId>("agent-2");
export const OUTSIDE_AGENT = asIdentifier<AgentId>("agent-3");
export const CLUSTER = asIdentifier<ClusterId>("cluster-1");
export const THREAD = asIdentifier<ThreadId>("thread-1");

export function subjectFixture(overrides: Partial<MemorySubject> = {}): MemorySubject {
  return {
    ...memorySubject(ENVIRONMENT_SCOPE, SUBJECT_ID),
    ...overrides,
  };
}

export function bindingFixture(overrides: Partial<AgentBinding> = {}): AgentBinding {
  return { agentId: AGENT, clusterId: null, ...overrides };
}

/** A clock a test can step. Nothing in this package reads the wall clock. */
export function stepClock(start: Date = FIXED_NOW): Clock & { advance(ms: number): void } {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** Counting ids, so a failure message names `mem-3` rather than a uuid. */
export function countingIds(prefix = "id"): IdGenerator {
  let sequence = 0;
  return {
    uuid: () => asIdentifier<Uuid>(`${prefix}-${(sequence += 1)}`),
    ulid: () => asIdentifier<Ulid>(`${prefix}-${(sequence += 1)}`),
  };
}

/**
 * A unit of work that runs its body and hands out a counted transaction id.
 *
 * It does not roll anything back, and that is the honest limit of an in-memory
 * double: atomicity is a property of the adapter. What it DOES prove is that
 * every write went through a transaction, because a use case that skipped one
 * would have no handle to pass.
 */
export function countingUnitOfWork(): UnitOfWork & { readonly transactions: string[] } {
  const transactions: string[] = [];
  return {
    transactions,
    run: async (work) => {
      const transactionId = `txn-${transactions.length + 1}`;
      transactions.push(transactionId);
      return work({ transactionId: asIdentifier(transactionId) });
    },
  };
}

export function memoryFixture(overrides: Partial<Memory> = {}): Memory {
  return {
    memoryId: asIdentifier<MemoryId>("mem-1"),
    subject: subjectFixture(),
    ownership: { agentId: AGENT, clusterId: null },
    kind: "fact",
    profileKey: null,
    content: "prefers to be called Sam",
    metadata: null,
    visibility: "agent_visible",
    source: "manual",
    contentHash: null,
    provenance: NO_PROVENANCE,
    confidence: NO_CONFIDENCE,
    lifecycle: {
      lastAccessedAt: null,
      quarantinedAt: null,
      archivedAt: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    },
    ...overrides,
  };
}

export function entityFixture(overrides: Partial<MemoryEntity> = {}): MemoryEntity {
  return {
    entityId: asIdentifier<MemoryEntityId>("ent-1"),
    subject: subjectFixture(),
    ownership: { agentId: AGENT, clusterId: null },
    entityKey: asIdentifier<EntityKey>("acme-corp"),
    entityType: "org",
    label: "Acme Corp",
    aliases: [],
    metadata: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export function relationshipFixture(overrides: Partial<MemoryRelationship> = {}): MemoryRelationship {
  return {
    relationshipId: asIdentifier<MemoryRelationshipId>("rel-1"),
    subject: subjectFixture(),
    ownership: { agentId: AGENT, clusterId: null },
    fromEntityId: asIdentifier<MemoryEntityId>("ent-1"),
    toEntityId: asIdentifier<MemoryEntityId>("ent-2"),
    relationshipType: "works_at",
    weight: null,
    metadata: null,
    sourceMemoryId: null,
    createdAt: FIXED_NOW,
    ...overrides,
  };
}

export function turnFixture(sequence: number, overrides: Partial<TranscriptTurn> = {}): TranscriptTurn {
  return {
    turnId: `turn-${sequence}`,
    sequence,
    inputText: `what I said at ${sequence}`,
    outputText: `what it replied at ${sequence}`,
    ...overrides,
  };
}

export function turnsFixture(count: number): readonly TranscriptTurn[] {
  return Array.from({ length: count }, (_unused, index) => turnFixture(index + 1));
}

export function runtimeGrant(
  overrides: {
    readonly endUserId?: EndUserId;
    readonly actingAgentId?: AgentId | null;
    readonly environmentId?: string;
  } = {},
): MemoryRuntimeAuthorization {
  return authorizeMemoryRuntime({
    ancestry: {
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentId: asIdentifier<EnvironmentId>(overrides.environmentId ?? ENVIRONMENT),
    },
    endUserId: overrides.endUserId ?? SUBJECT_ID,
    actingAgentId: overrides.actingAgentId === undefined ? AGENT : overrides.actingAgentId,
    actorId: asIdentifier<ActorId>("actor-1"),
  });
}

/** Everything a test needs, wired, with each double reachable for assertions. */
export interface MemoryHarness {
  readonly dependencies: MemoryDependencies;
  readonly repository: InMemoryMemoryRepository;
  readonly graph: InMemoryKnowledgeGraphRepository;
  readonly cache: InMemoryCache;
  readonly embeddings: InMemoryEmbeddingModel;
  readonly judge: InMemoryExtractionJudge;
  readonly tenancy: InMemoryTenancy;
  readonly providers: InMemoryProviders;
  readonly clock: Clock & { advance(ms: number): void };
  readonly unitOfWork: UnitOfWork & { readonly transactions: string[] };
}

export function harness(
  overrides: { readonly policy?: MemoryPolicy; readonly bindings?: readonly AgentBinding[] } = {},
): MemoryHarness {
  const clock = stepClock();
  const repository = new InMemoryMemoryRepository(overrides.bindings ?? [bindingFixture()]);
  const graph = new InMemoryKnowledgeGraphRepository();
  const cache = new InMemoryCache(clock);
  const embeddings = new InMemoryEmbeddingModel();
  const judge = new InMemoryExtractionJudge();
  const tenancy = new InMemoryTenancy(ENVIRONMENT_SCOPE);
  const providers = new InMemoryProviders();
  const unitOfWork = countingUnitOfWork();

  return {
    repository,
    graph,
    cache,
    embeddings,
    judge,
    tenancy,
    providers,
    clock,
    unitOfWork,
    dependencies: {
      repository,
      graph,
      cache,
      embeddings,
      judge,
      digest: countingDigest(),
      clock,
      ids: countingIds("mem"),
      unitOfWork,
      policy: overrides.policy ?? DEFAULT_MEMORY_POLICY,
      tenancy,
      providers,
    },
  };
}
