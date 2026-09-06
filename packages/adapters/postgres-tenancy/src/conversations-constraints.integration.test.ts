// Every write GUARD, stood beside the migration constraint it restates.
//
// TWO HALVES PER CASE, ALWAYS. The first asks the STORE and expects a refusal
// carrying the guard's own code; the second sends the same value to the DATABASE
// by raw SQL and expects the database to refuse it too. A guard whose constraint
// has been dropped is a guard nobody can delete safely, and a guard the database
// does not actually back is a store inventing a rule.
//
// NOT ONE of these constraints is in `schema.prisma`. Every one lives only in
// `internal-packages/tenancy-database/prisma/migrations`, and the four in-memory
// doubles this context ships enforce NONE of them — which is the whole reason
// this file exists. The context's own `threadFixture` mints `thread-1` and its
// `stepFixture` a `modelPriceId` of `price-1`; both satisfy every double in the
// package and both are refused by `@db.Uuid`.
//
// THE RAW HALF USES `$executeRawUnsafe` AND SPELLS ITS SQL AT THE CALL SITE, for
// the reason `agents-constraints.integration.test.ts` gives: a helper that
// assembled the statement would be unattributable to the ADR M0.3 §5.2
// sole-writer lint, and the lint is right to refuse SQL built at run time. Every
// statement below names its table literally.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  asConversationsIdentifier,
  money,
  rollUpTurnCost,
  sumStepUsage,
  type ActorId,
  type AgentId,
  type AgentVersionId,
  type EndUserId,
  type EnvironmentScope,
  type ModelPriceId,
  type PostmanContextHandle,
  type PostmanExecution,
  type PostmanExecutionId,
  type Step,
  type StepId,
  type Thread,
  type ThreadId,
  type Turn,
  type TurnId,
} from "@platos/context-conversations/application/ports/index.js";

import {
  CONTEXT_HANDLE_MALFORMED,
  CONVERSATIONS_IDENTIFIER_NOT_UUID,
  EXECUTION_TURN_WITHOUT_THREAD,
  FORK_LINEAGE_INCOHERENT,
  FORK_LINEAGE_REPEATED,
  MEASUREMENT_NEGATIVE,
  REQUEST_FINGERPRINT_MALFORMED,
  SEQUENCE_OUT_OF_RANGE,
  SESSION_CONTEXT_NOT_OBJECT,
  STEP_CACHE_EXCEEDS_INPUT,
  STEP_PRICE_SNAPSHOT_INCOMPLETE,
  STEP_USAGE_NEGATIVE,
  TIMESTAMPS_INCOHERENT,
  TURN_JSON_NOT_OBJECT,
} from "./conversations-guards.js";
import type { ConversationsHarness, PeerChain } from "./conversations-harness.js";
import { startConversationsHarness } from "./conversations-harness.js";

let harness: ConversationsHarness;
let chain: PeerChain;
let scope: EnvironmentScope;
let threadId: ThreadId;
let turnId: TurnId;

const AT = new Date("2026-05-01T09:00:00.000Z");
const uuid = (tail: string) => `c1000000-0000-4000-8000-${tail.padStart(12, "0")}`;

/**
 * The raw client, resolved at the call site.
 *
 * Typed structurally so this suite names no vendor type: `client.ts` is the one
 * file in the layout entitled to, and a second naming here would be a second
 * import of the ORM in a package whose whole point is having one.
 */
function db(): { $executeRawUnsafe(text: string, ...values: unknown[]): Promise<number> } {
  return harness.base.client as unknown as {
    $executeRawUnsafe(text: string, ...values: unknown[]): Promise<number>;
  };
}

async function refusedByDatabase(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the database accepted a row the guard refuses");
}

function threadOf(overrides: Partial<Thread> = {}): Thread {
  return Object.freeze({
    threadId: asConversationsIdentifier<ThreadId>(uuid("1")),
    agentId: asConversationsIdentifier<AgentId>(chain.agentId),
    endUserId: asConversationsIdentifier<EndUserId>(chain.endUserId),
    clusterId: null,
    parentThreadId: null,
    forkedUpToTurnId: null,
    forkedTurnIds: Object.freeze([]),
    compactedUpToTurnId: null,
    title: null,
    status: "ACTIVE" as const,
    summary: null,
    compactionState: "IDLE" as const,
    compactedAt: null,
    sessionContext: null,
    tags: Object.freeze([]),
    pinnedAt: null,
    archivedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

function turnOf(overrides: Partial<Turn> = {}): Turn {
  return Object.freeze({
    turnId: asConversationsIdentifier<TurnId>(uuid("11")),
    threadId,
    parentTurnId: null,
    agentVersionId: asConversationsIdentifier<AgentVersionId>(chain.agentVersionId),
    versionBucket: "CURRENT" as const,
    sequence: 1,
    inputText: "hello",
    outputText: null,
    input: null,
    output: null,
    thinkingContent: null,
    status: "PENDING" as const,
    externalRuntimeId: null,
    idempotencyKey: null,
    cost: rollUpTurnCost([]),
    usage: sumStepUsage([]),
    latencyMs: null,
    startedAt: null,
    completedAt: null,
    createdAt: AT,
    ...overrides,
  });
}

function stepOf(overrides: Partial<Step> = {}): Step {
  return Object.freeze({
    stepId: asConversationsIdentifier<StepId>(uuid("21")),
    turnId,
    sequence: 1,
    model: "anthropic:claude-test",
    status: "SUCCEEDED" as const,
    retryCount: 0,
    usage: Object.freeze({
      inputTokens: 1_000,
      outputTokens: 200,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
    }),
    cost: null,
    modelPriceId: null,
    rates: Object.freeze({ input: null, output: null, cacheRead: null, cacheWrite: null }),
    latencyMs: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: AT,
    ...overrides,
  });
}

function executionOf(overrides: Partial<PostmanExecution> = {}): PostmanExecution {
  return Object.freeze({
    executionId: asConversationsIdentifier<PostmanExecutionId>(uuid("31")),
    agentId: asConversationsIdentifier<AgentId>(chain.agentId),
    templateId: null,
    requestId: uuid("41"),
    requestFingerprint: "b".repeat(64),
    actorUserId: asConversationsIdentifier<ActorId>(chain.actorUserId),
    simulatedEndUserId: null,
    contextHandle: asConversationsIdentifier<PostmanContextHandle>(uuid("51")),
    contextExpiresAt: AT,
    status: "PENDING" as const,
    threadId: null,
    turnId: null,
    completedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

beforeAll(async () => {
  harness = await startConversationsHarness();
  scope = await harness.freshScope();
  chain = await harness.seedChain(scope);
  threadId = asConversationsIdentifier<ThreadId>(uuid("2"));
  turnId = asConversationsIdentifier<TurnId>(uuid("12"));
  const created = await harness.stores.threads.createThread(
    scope,
    threadOf({ threadId }),
  );
  expect(created.ok).toBe(true);
  const turn = await harness.stores.turns.createTurn(scope, turnOf({ turnId, sequence: 1 }));
  expect(turn.ok).toBe(true);
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("@db.Uuid — a non-uuid identifier is a driver fault, not a constraint", () => {
  test("the store refuses `thread-1`, which every in-memory double accepts", async () => {
    // THE CONTEXT'S OWN FIXTURE MINTS THIS EXACT STRING. `threadFixture` in
    // `application/testing/fixtures.ts` uses `THREAD_ID = "thread-1"`, and every
    // use-case suite in that package is green with it.
    const refused = await harness.stores.threads.createThread(
      scope,
      threadOf({ threadId: asConversationsIdentifier<ThreadId>("thread-1") }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain(CONVERSATIONS_IDENTIFIER_NOT_UUID);
  });

  test("the database refuses it too, and not with a constraint name", async () => {
    const message = await refusedByDatabase(() =>
      db().$executeRawUnsafe(
        `INSERT INTO "Thread" ("id", "environmentId", "agentId", "endUserId", "status", "createdAt", "updatedAt")
         VALUES ('thread-1', $1::uuid, $2::uuid, $3::uuid, 'ACTIVE', now(), now())`,
        scope.environmentId,
        chain.agentId,
        chain.endUserId,
      ),
    );
    // The message is about the UUID CONVERSION and names no constraint, which is
    // exactly why the guard exists: there is no SQLSTATE here for a caller to act
    // on and the whole transaction is already gone by the time it arrives.
    expect(message.toLowerCase()).toContain("uuid");
  });

  test("`price-1` on a step is refused the same way", async () => {
    const refused = await harness.stores.turns.saveSettlement(scope, {
      turn: turnOf({ turnId, status: "SUCCEEDED" }),
      steps: [stepOf({ modelPriceId: asConversationsIdentifier<ModelPriceId>("price-1") })],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain(CONVERSATIONS_IDENTIFIER_NOT_UUID);
  });
});

describe("Thread_sessionContext_json_root", () => {
  test("the store refuses an array root", async () => {
    const refused = await harness.stores.threads.createThread(
      scope,
      threadOf({
        threadId: asConversationsIdentifier<ThreadId>(uuid("3")),
        sessionContext: [1, 2] as unknown as Thread["sessionContext"],
      }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain(SESSION_CONTEXT_NOT_OBJECT);
  });

  test("the database refuses it, naming the constraint", async () => {
    const message = await refusedByDatabase(() =>
      db().$executeRawUnsafe(
        `INSERT INTO "Thread" ("id", "environmentId", "agentId", "endUserId", "status", "sessionContext", "createdAt", "updatedAt")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', '[1,2]'::jsonb, now(), now())`,
        uuid("4"),
        scope.environmentId,
        chain.agentId,
        chain.endUserId,
      ),
    );
    expect(message).toContain("Thread_sessionContext_json_root");
  });
});

describe("Thread_ancestry — the fork lineage rule nothing outside the migration states", () => {
  test("the store refuses a boundary that is not the LAST inherited turn", async () => {
    const refused = await harness.stores.threads.createThread(
      scope,
      threadOf({
        threadId: asConversationsIdentifier<ThreadId>(uuid("5")),
        parentThreadId: threadId,
        forkedTurnIds: [turnId, asConversationsIdentifier<TurnId>(uuid("13"))],
        forkedUpToTurnId: turnId,
      }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain(FORK_LINEAGE_INCOHERENT);
  });

  test("the store refuses a boundary set with an EMPTY lineage", async () => {
    const refused = await harness.stores.threads.createThread(
      scope,
      threadOf({
        threadId: asConversationsIdentifier<ThreadId>(uuid("6")),
        parentThreadId: threadId,
        forkedUpToTurnId: turnId,
      }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain(FORK_LINEAGE_INCOHERENT);
  });

  test("the store refuses a lineage that names one turn twice, under its OWN code", async () => {
    // A SEPARATE CODE from the boundary mismatch, because they are separate
    // mistakes: one is a caller that lost track of the order, the other a caller
    // that appended the same ancestor twice. The trigger's own clause is
    // `cardinality(...) = (SELECT count(DISTINCT ...))`.
    const refused = await harness.stores.threads.createThread(
      scope,
      threadOf({
        threadId: asConversationsIdentifier<ThreadId>(uuid("7")),
        parentThreadId: threadId,
        forkedTurnIds: [turnId, turnId],
        forkedUpToTurnId: turnId,
      }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain(FORK_LINEAGE_REPEATED);
  });

  test("the database refuses the same three, as one ancestry violation", async () => {
    const message = await refusedByDatabase(() =>
      db().$executeRawUnsafe(
        `INSERT INTO "Thread" ("id", "environmentId", "agentId", "endUserId", "status",
                              "parentThreadId", "forkedTurnIds", "forkedUpToTurnId", "createdAt", "updatedAt")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', $5::uuid,
                 ARRAY[$6::uuid, $6::uuid], $6::uuid, now(), now())`,
        uuid("8"),
        scope.environmentId,
        chain.agentId,
        chain.endUserId,
        threadId,
        turnId,
      ),
    );
    // ONE message for all three shapes, which is exactly why the store mints two
    // codes of its own: the database cannot say which clause failed.
    expect(message).toContain("Thread crosses its canonical owner ancestry");
  });
});

describe("Turn_usage_check", () => {
  test("the store refuses a sequence of zero", async () => {
    const refused = await harness.stores.turns.createTurn(
      scope,
      turnOf({ turnId: asConversationsIdentifier<TurnId>(uuid("14")), sequence: 0 }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain(SEQUENCE_OUT_OF_RANGE);
  });

  test("the store refuses a negative latency", async () => {
    const refused = await harness.stores.turns.createTurn(
      scope,
      turnOf({ turnId: asConversationsIdentifier<TurnId>(uuid("15")), sequence: 9, latencyMs: -1 }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain(MEASUREMENT_NEGATIVE);
  });

  test("the store refuses a turn that completed before it started", async () => {
    const refused = await harness.stores.turns.createTurn(
      scope,
      turnOf({
        turnId: asConversationsIdentifier<TurnId>(uuid("16")),
        sequence: 10,
        startedAt: new Date(AT.getTime() + 1_000),
        completedAt: AT,
      }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain(TIMESTAMPS_INCOHERENT);
  });

  test("the database refuses all three, naming one constraint", async () => {
    for (const values of [
      { sequence: 0, latency: "NULL", started: "NULL", completed: "NULL", tail: "17" },
      { sequence: 11, latency: "-1", started: "NULL", completed: "NULL", tail: "18" },
      {
        sequence: 12,
        latency: "NULL",
        started: "'2026-05-01T09:00:01Z'",
        completed: "'2026-05-01T09:00:00Z'",
        tail: "19",
      },
    ]) {
      const message = await refusedByDatabase(() =>
        db().$executeRawUnsafe(
          `INSERT INTO "Turn" ("id", "threadId", "agentVersionId", "versionBucket", "sequence",
                              "status", "latencyMs", "startedAt", "completedAt", "createdAt")
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'CURRENT', ${String(values.sequence)},
                   'PENDING', ${values.latency}, ${values.started}, ${values.completed}, now())`,
          uuid(values.tail),
          threadId,
          chain.agentVersionId,
        ),
      );
      expect(message).toContain("Turn_usage_check");
    }
  });
});

describe("Turn_input_json_root and Turn_output_json_root", () => {
  test("the store refuses a non-object in either, under ONE code", async () => {
    for (const patch of [{ input: [] }, { output: [] }] as readonly unknown[]) {
      const refused = await harness.stores.turns.createTurn(
        scope,
        turnOf({
          turnId: asConversationsIdentifier<TurnId>(uuid("1a")),
          sequence: 13,
          ...(patch as Partial<Turn>),
        }),
      );
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.error.message).toContain(TURN_JSON_NOT_OBJECT);
    }
  });

  test("the database refuses an array in `Turn.input`", async () => {
    const message = await refusedByDatabase(() =>
      db().$executeRawUnsafe(
        `INSERT INTO "Turn" ("id", "threadId", "agentVersionId", "versionBucket", "sequence",
                            "status", "input", "createdAt")
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'CURRENT', 14, 'PENDING', '[]'::jsonb, now())`,
        uuid("1b"),
        threadId,
        chain.agentVersionId,
      ),
    );
    expect(message).toContain("Turn_input_json_root");
  });
});

describe("Step_usage_check", () => {
  test("the store refuses a negative token count", async () => {
    const refused = await harness.stores.turns.saveSettlement(scope, {
      turn: turnOf({ turnId, status: "SUCCEEDED" }),
      steps: [
        stepOf({
          usage: {
            inputTokens: -1,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            reasoningTokens: 0,
          },
        }),
      ],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain(STEP_USAGE_NEGATIVE);
  });

  test("the store refuses cache figures that exceed the input total, under its OWN code", async () => {
    // THE ONE THE DOMAIN DOES NOT CATCH EITHER WAY. `domain/step-usage.ts` says
    // the two cache figures are PARTS of `inputTokens`; the constraint says so in
    // SQL; and a step whose cache reads exceed its input is a provider report
    // this system cannot charge for twice.
    const refused = await harness.stores.turns.saveSettlement(scope, {
      turn: turnOf({ turnId, status: "SUCCEEDED" }),
      steps: [
        stepOf({
          usage: {
            inputTokens: 100,
            outputTokens: 0,
            cacheCreationInputTokens: 80,
            cacheReadInputTokens: 80,
            reasoningTokens: 0,
          },
        }),
      ],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain(STEP_CACHE_EXCEEDS_INPUT);
  });

  test("the store refuses a priced step with no price snapshot", async () => {
    const refused = await harness.stores.turns.saveSettlement(scope, {
      turn: turnOf({ turnId, status: "SUCCEEDED" }),
      steps: [stepOf({ cost: money(4_500_000n) })],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain(STEP_PRICE_SNAPSHOT_INCOMPLETE);
  });

  test("the database refuses all three, naming one constraint", async () => {
    for (const values of [
      { columns: `"inputTokens"`, values: `-1`, tail: "22" },
      {
        columns: `"inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"`,
        values: `100, 80, 80`,
        tail: "23",
      },
      { columns: `"costCents"`, values: `4.5`, tail: "24" },
    ]) {
      const message = await refusedByDatabase(() =>
        db().$executeRawUnsafe(
          `INSERT INTO "Step" ("id", "turnId", "sequence", "model", "status", ${values.columns}, "createdAt")
           VALUES ($1::uuid, $2::uuid, 5, 'anthropic:claude-test', 'SUCCEEDED', ${values.values}, now())`,
          uuid(values.tail),
          turnId,
        ),
      );
      expect(message).toContain("Step_usage_check");
    }
  });
});

describe("PostmanExecution_requestFingerprint_check and _contextHandle_check", () => {
  test("the store refuses a fingerprint that is not 64 lowercase hex", async () => {
    for (const fingerprint of ["A".repeat(64), "b".repeat(63), "zz"]) {
      const refused = await harness.stores.postman.createExecution(
        scope,
        executionOf({ requestFingerprint: fingerprint }),
      );
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.error.message).toContain(REQUEST_FINGERPRINT_MALFORMED);
    }
  });

  test("the store refuses a handle whose VERSION or VARIANT nibble is wrong", async () => {
    // THE CHECK PINS BOTH NIBBLES: version 1-8 and variant 8/9/a/b. A version-0
    // uuid is a perfectly good uuid for `@db.Uuid` and is refused by this column
    // alone, which is why the guard restates the pattern rather than reusing the
    // ordinary uuid one.
    for (const handle of [
      "c0000005-0000-0000-8000-000000000001",
      "c0000005-0000-4000-c000-000000000001",
      "C0000005-0000-4000-8000-000000000001",
    ]) {
      const refused = await harness.stores.postman.createExecution(
        scope,
        executionOf({ contextHandle: asConversationsIdentifier<PostmanContextHandle>(handle) }),
      );
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.error.message).toContain(CONTEXT_HANDLE_MALFORMED);
    }
  });

  test("the database refuses both, naming its own constraint each time", async () => {
    const fingerprint = await refusedByDatabase(() =>
      db().$executeRawUnsafe(
        `INSERT INTO "PostmanExecution" ("id", "environmentId", "agentId", "requestId",
                                        "requestFingerprint", "actorUserId", "contextHandle",
                                        "contextExpiresAt", "status", "createdAt", "updatedAt")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'NOTHEX', $5::uuid, $6, now(), 'PENDING', now(), now())`,
        uuid("32"),
        scope.environmentId,
        chain.agentId,
        uuid("42"),
        chain.actorUserId,
        uuid("52"),
      ),
    );
    expect(fingerprint).toContain("PostmanExecution_requestFingerprint_check");

    const handle = await refusedByDatabase(() =>
      db().$executeRawUnsafe(
        `INSERT INTO "PostmanExecution" ("id", "environmentId", "agentId", "requestId",
                                        "requestFingerprint", "actorUserId", "contextHandle",
                                        "contextExpiresAt", "status", "createdAt", "updatedAt")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, 'not-a-handle', now(), 'PENDING', now(), now())`,
        uuid("33"),
        scope.environmentId,
        chain.agentId,
        uuid("43"),
        "b".repeat(64),
        chain.actorUserId,
      ),
    );
    expect(handle).toContain("PostmanExecution_contextHandle_check");
  });
});

describe("PostmanExecution_ancestry — a turn link needs a thread link", () => {
  test("the store refuses a turn with no thread, under its own code", async () => {
    const refused = await harness.stores.postman.createExecution(
      scope,
      executionOf({ executionId: asConversationsIdentifier<PostmanExecutionId>(uuid("34")), turnId, threadId: null }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain(EXECUTION_TURN_WITHOUT_THREAD);
  });

  test("the database refuses it as an ancestry violation, naming neither column", async () => {
    const message = await refusedByDatabase(() =>
      db().$executeRawUnsafe(
        `INSERT INTO "PostmanExecution" ("id", "environmentId", "agentId", "requestId",
                                        "requestFingerprint", "actorUserId", "contextHandle",
                                        "contextExpiresAt", "status", "turnId", "createdAt", "updatedAt")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, $7, now(), 'PENDING', $8::uuid, now(), now())`,
        uuid("35"),
        scope.environmentId,
        chain.agentId,
        uuid("45"),
        "b".repeat(64),
        chain.actorUserId,
        uuid("55"),
        turnId,
      ),
    );
    expect(message).toContain("PostmanExecution crosses its canonical owner ancestry");
  });
});
