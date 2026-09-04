// The one place a test builds a whole context out of doubles.
//
// EVERY FIXTURE IS A FUNCTION, NOT A SHARED CONSTANT. Two suites sharing one
// mutable store is how a test passes alone and fails in a run, and how an
// assertion about "the only thread" quietly starts being about the third.
//
// THE STORE IS SNAPSHOTTABLE, WHICH IS WHAT MAKES THE TRANSACTION DOUBLE HONEST.
// `TestUnitOfWork` restores the snapshot when the work returns an error
// `Result`, so a use case that refuses halfway leaves nothing behind — the
// behaviour a real transaction has and the one a naive double does not.

import { asIdentifier, type EnvironmentScope } from "@platos/kernel";

import {
  DEFAULT_CONVERSATIONS_POLICY,
  openStep,
  openThread,
  openTurn,
  settleStep,
  type AgentId,
  type AgentVersionId,
  type ConversationsPolicy,
  type EndUserId,
  type ModelPriceId,
  type Step,
  type StepId,
  type Thread,
  type ThreadId,
  type Turn,
  type TurnId,
} from "../../domain/index.js";
import { conversationsDependencies, type ConversationsDependencies } from "../dependencies.js";
import {
  TestClock,
  TestIds,
  TestLogger,
  TestOutbox,
  TestUnitOfWork,
  type Snapshottable,
} from "./in-memory-infrastructure.js";
import {
  InMemoryAgents,
  InMemoryCostMonitoring,
  InMemoryFiles,
  InMemoryJobs,
  InMemoryMemory,
  InMemorySkills,
  InMemoryTenancy,
  InMemoryTools,
} from "./in-memory-peers.js";
import { InMemoryProviders, priceTestUsage } from "./in-memory-providers.js";
import { InMemoryConversations, testScope } from "./in-memory-stores.js";

export { priceTestUsage, TEST_RATES } from "./in-memory-providers.js";

export const THREAD_ID = asIdentifier<ThreadId>("thread-1");
export const AGENT_ID = asIdentifier<AgentId>("agent-1");
export const END_USER_ID = asIdentifier<EndUserId>("end-user-1");
export const VERSION_ID = asIdentifier<AgentVersionId>("ver-1");

/** The store, wrapped so `TestUnitOfWork` can undo it. */
class SnapshottableStore extends InMemoryConversations implements Snapshottable {
  snapshot(): unknown {
    return {
      threads: new Map(this.threads),
      turns: new Map(this.turns),
      steps: new Map([...this.steps].map(([key, value]) => [key, [...value]])),
      executions: new Map(this.executions),
    };
  }

  restore(state: unknown): void {
    const saved = state as {
      threads: Map<string, Thread>;
      turns: Map<string, Turn>;
      steps: Map<string, Step[]>;
      executions: Map<string, never>;
    };
    this.threads.clear();
    for (const [key, value] of saved.threads) this.threads.set(key, value);
    this.turns.clear();
    for (const [key, value] of saved.turns) this.turns.set(key, value);
    this.steps.clear();
    for (const [key, value] of saved.steps) this.steps.set(key, [...value]);
    this.executions.clear();
    for (const [key, value] of saved.executions) this.executions.set(key, value);
  }
}

export interface ConversationsTestContext {
  readonly dependencies: ConversationsDependencies;
  readonly store: SnapshottableStore;
  readonly clock: TestClock;
  readonly ids: TestIds;
  readonly unitOfWork: TestUnitOfWork;
  readonly outbox: TestOutbox;
  readonly logger: TestLogger;
  readonly tenancy: InMemoryTenancy;
  readonly agents: InMemoryAgents;
  readonly skills: InMemorySkills;
  readonly tools: InMemoryTools;
  readonly memory: InMemoryMemory;
  readonly providers: InMemoryProviders;
  readonly files: InMemoryFiles;
  readonly costMonitoring: InMemoryCostMonitoring;
  readonly jobs: InMemoryJobs;
  readonly scope: EnvironmentScope;
}

export function buildConversationsTestContext(
  policy: ConversationsPolicy = DEFAULT_CONVERSATIONS_POLICY,
): ConversationsTestContext {
  const scope = testScope();
  const store = new SnapshottableStore();
  const clock = new TestClock();
  const ids = new TestIds();
  const unitOfWork = new TestUnitOfWork([store]);
  const outbox = new TestOutbox();
  const logger = new TestLogger();
  const tenancy = new InMemoryTenancy(scope);
  const agents = new InMemoryAgents();
  const skills = new InMemorySkills();
  const tools = new InMemoryTools();
  const memory = new InMemoryMemory();
  const providers = new InMemoryProviders();
  const files = new InMemoryFiles();
  const costMonitoring = new InMemoryCostMonitoring();
  const jobs = new InMemoryJobs();

  const dependencies = conversationsDependencies({
    threads: store,
    turns: store,
    postman: store,
    erasureStore: store,
    clock,
    ids,
    unitOfWork,
    outbox,
    logger,
    policy,
    agents,
    skills,
    tools,
    memory,
    providers,
    files,
    costMonitoring,
    jobs,
    tenancy,
  });

  return {
    dependencies,
    store,
    clock,
    ids,
    unitOfWork,
    outbox,
    logger,
    tenancy,
    agents,
    skills,
    tools,
    memory,
    providers,
    files,
    costMonitoring,
    jobs,
    scope,
  };
}

/**
 * A runtime grant.
 *
 * MINTED, NOT BUILT. `secrets` brands its grants with a unique symbol and mints
 * them through a register, so a literal is not one. A test cannot import the
 * mint without taking a dependency this context does not have, so the fixture
 * asserts the shape — and `authorization.test.ts` covers the ONE property that
 * matters here, which is that the grant's ancestry is compared against the
 * scope, not that it was minted.
 */
export function runtimeGrant(
  scope: EnvironmentScope = testScope(),
): import("../authorization.js").SecretsRuntimeGrant {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    principalType: "runtime",
    tier: "RUNTIME",
    access: "secret:read",
    actorId: "runtime-1",
  } as unknown as import("../authorization.js").SecretsRuntimeGrant;
}

export function threadFixture(overrides: Partial<Thread> = {}): Thread {
  const opened = openThread(
    {
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      endUserId: END_USER_ID,
      at: new Date("2026-01-01T00:00:00.000Z"),
    },
    DEFAULT_CONVERSATIONS_POLICY.thread,
  );
  if (!opened.ok) throw new Error(opened.error.code);
  return Object.freeze({ ...opened.value, ...overrides });
}

export function turnFixture(overrides: Partial<Turn> = {}): Turn {
  const opened = openTurn(
    {
      turnId: asIdentifier<TurnId>("turn-1"),
      threadId: THREAD_ID,
      agentVersionId: VERSION_ID,
      versionBucket: "CURRENT",
      sequence: 1,
      inputText: "hello",
      at: new Date("2026-01-01T00:00:00.000Z"),
    },
    DEFAULT_CONVERSATIONS_POLICY.turn,
  );
  if (!opened.ok) throw new Error(opened.error.code);
  return Object.freeze({ ...opened.value, status: "SUCCEEDED", outputText: "hi", ...overrides });
}

/**
 * A settled step with REAL money on it.
 *
 * The cost is computed by the same arithmetic the pricing double uses, so a
 * fixture and an assertion cannot drift apart, and it is never zero — a step
 * fixture that cost nothing would let every money assertion in the package pass
 * against a system that charged nothing.
 */
export function stepFixture(
  overrides: {
    stepId?: string;
    turnId?: string;
    sequence?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    reasoningTokens?: number;
  } = {},
): Step {
  const at = new Date("2026-01-01T00:00:00.000Z");
  const open = openStep({
    stepId: asIdentifier<StepId>(overrides.stepId ?? "step-1"),
    turnId: asIdentifier<TurnId>(overrides.turnId ?? "turn-1"),
    sequence: overrides.sequence ?? 1,
    model: "anthropic:claude-test",
    startedAt: at,
  });

  const usage = {
    inputTokens: overrides.inputTokens ?? 1_000,
    outputTokens: overrides.outputTokens ?? 200,
    cacheCreationInputTokens: overrides.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: overrides.cacheReadInputTokens ?? 0,
    reasoningTokens: overrides.reasoningTokens ?? 0,
  };
  const fresh = usage.inputTokens - usage.cacheReadInputTokens - usage.cacheCreationInputTokens;
  const cents = priceTestUsage({
    input: Math.max(0, fresh),
    output: usage.outputTokens,
    cacheRead: usage.cacheReadInputTokens,
    cacheWrite: usage.cacheCreationInputTokens,
  });

  const rate = (usdPerToken: string) => ({
    usdPerToken,
    source: "LITELLM" as const,
    observedAt: at,
    sourceRef: null,
  });

  const settled = settleStep(open, {
    status: "SUCCEEDED",
    usage,
    cost: moneyFrom(cents),
    modelPriceId: asIdentifier<ModelPriceId>("price-1"),
    rates: {
      input: rate("0.000003000000"),
      output: rate("0.000015000000"),
      cacheRead: rate("0.000000300000"),
      cacheWrite: rate("0.000003750000"),
    },
    error: null,
    completedAt: at,
  });
  if (!settled.ok) throw new Error(settled.error.code);
  return settled.value;
}

function moneyFrom(cents: string) {
  const [whole = "0", fraction = ""] = cents.split(".");
  const microCents = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return { microCents, currency: "USD" as never };
}
