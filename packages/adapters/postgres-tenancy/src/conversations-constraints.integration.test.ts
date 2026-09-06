// Every write GUARD over a `Thread` or a `Turn`, stood beside the migration
// constraint it restates.
//
// TWO HALVES PER CASE, ALWAYS. The first asks the STORE and expects a refusal
// carrying the guard's own code; the second sends the same value to the DATABASE
// by raw SQL and expects the database to refuse it too. A guard whose constraint
// has been dropped is a guard nobody can delete safely, and a guard the database
// does not actually back is a store inventing a rule.
//
// NOT ONE of these constraints is in `schema.prisma`. Every one lives only in
// `internal-packages/tenancy-database/prisma/migrations`, and the in-memory
// double this context ships enforces NONE of them — which is the whole reason
// this file exists. The context's own `threadFixture` mints `thread-1` and its
// `stepFixture` a `modelPriceId` of `price-1`; both satisfy every double in that
// package and both are refused by `@db.Uuid`.
//
// THE STEP AND THE POSTMAN EXECUTION ARE IN A FILE OF THEIR OWN. `max-file-lines`
// bit at the hard error and the seam it pointed at is real: this file is about
// the shapes a CONVERSATION admits, and
// `conversations-billing-constraints.integration.test.ts` is about the shapes a
// BILL and an OPERATOR'S AUDIT ROW admit.
//
// THE RAW HALF USES `$executeRawUnsafe` AND SPELLS ITS SQL AT THE CALL SITE, for
// the reason `agents-constraints.integration.test.ts` gives: a helper that
// assembled the statement would be unattributable to the ADR M0.3 §5.2
// sole-writer lint, and the lint is right to refuse SQL built at run time. Every
// statement below names its table literally.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  asConversationsIdentifier,
  type EnvironmentScope,
  type Thread,
  type ThreadId,
  type Turn,
  type TurnId,
} from "@platos/context-conversations/application/ports/index.js";

import {
  CONVERSATIONS_IDENTIFIER_NOT_UUID,
  FORK_LINEAGE_INCOHERENT,
  FORK_LINEAGE_REPEATED,
  MEASUREMENT_NEGATIVE,
  SEQUENCE_OUT_OF_RANGE,
  SESSION_CONTEXT_NOT_OBJECT,
  TIMESTAMPS_INCOHERENT,
  TURN_JSON_NOT_OBJECT,
} from "./conversations-guards.js";
import { AT, rawClient, refusedByDatabase, threadOf, turnOf } from "./conversations-fixtures.js";
import type { ConversationsHarness, PeerChain } from "./conversations-harness.js";
import { startConversationsHarness } from "./conversations-harness.js";

let harness: ConversationsHarness;
let chain: PeerChain;
let scope: EnvironmentScope;
let threadId: ThreadId;
let turnId: TurnId;

const uuid = (tail: string) => `c1000000-0000-4000-8000-${tail.padStart(12, "0")}`;

async function refusedByStore(work: () => Promise<{ readonly ok: boolean }>): Promise<string> {
  const outcome = (await work()) as { ok: boolean; error?: { message: string } };
  if (outcome.ok) throw new Error("the store accepted a value the database refuses");
  return outcome.error?.message ?? "";
}

beforeAll(async () => {
  harness = await startConversationsHarness();
  scope = await harness.freshScope();
  chain = await harness.seedChain(scope);
  threadId = asConversationsIdentifier<ThreadId>(uuid("2"));
  turnId = asConversationsIdentifier<TurnId>(uuid("12"));
  expect((await harness.stores.threads.createThread(scope, threadOf(chain, threadId))).ok).toBe(
    true,
  );
  expect((await harness.stores.turns.createTurn(scope, turnOf(chain, turnId, threadId, 1))).ok).toBe(
    true,
  );
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("@db.Uuid — a non-uuid identifier is a driver fault, not a constraint", () => {
  test("the store refuses `thread-1`, which every in-memory double accepts", async () => {
    // THE CONTEXT'S OWN FIXTURE MINTS THIS EXACT STRING. `threadFixture` in
    // `application/testing/fixtures.ts` uses `THREAD_ID = "thread-1"`, and every
    // use-case suite in that package is green with it.
    const message = await refusedByStore(() =>
      harness.stores.threads.createThread(scope, threadOf(chain, "thread-1")),
    );
    expect(message).toContain(CONVERSATIONS_IDENTIFIER_NOT_UUID);
  });

  test("the database refuses it too, and not with a constraint name", async () => {
    const message = await refusedByDatabase(() =>
      rawClient(harness).$executeRawUnsafe(
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
});

describe("Thread_sessionContext_json_root", () => {
  test("the store refuses an array root", async () => {
    const message = await refusedByStore(() =>
      harness.stores.threads.createThread(
        scope,
        threadOf(chain, uuid("3"), {
          sessionContext: [1, 2] as unknown as Thread["sessionContext"],
        }),
      ),
    );
    expect(message).toContain(SESSION_CONTEXT_NOT_OBJECT);
  });

  test("the database refuses it, naming the constraint", async () => {
    const message = await refusedByDatabase(() =>
      rawClient(harness).$executeRawUnsafe(
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
    const message = await refusedByStore(() =>
      harness.stores.threads.createThread(
        scope,
        threadOf(chain, uuid("5"), {
          parentThreadId: threadId,
          forkedTurnIds: [turnId, asConversationsIdentifier<TurnId>(uuid("13"))],
          forkedUpToTurnId: turnId,
        }),
      ),
    );
    expect(message).toContain(FORK_LINEAGE_INCOHERENT);
  });

  test("the store refuses a boundary set with an EMPTY lineage", async () => {
    const message = await refusedByStore(() =>
      harness.stores.threads.createThread(
        scope,
        threadOf(chain, uuid("6"), { parentThreadId: threadId, forkedUpToTurnId: turnId }),
      ),
    );
    expect(message).toContain(FORK_LINEAGE_INCOHERENT);
  });

  test("the store refuses a lineage that names one turn twice, under its OWN code", async () => {
    // A SEPARATE CODE from the boundary mismatch, because they are separate
    // mistakes: one is a caller that lost track of the order, the other a caller
    // that appended the same ancestor twice. The rule's own clause is
    // `cardinality(...) = (SELECT count(DISTINCT ...))`.
    const message = await refusedByStore(() =>
      harness.stores.threads.createThread(
        scope,
        threadOf(chain, uuid("7"), {
          parentThreadId: threadId,
          forkedTurnIds: [turnId, turnId],
          forkedUpToTurnId: turnId,
        }),
      ),
    );
    expect(message).toContain(FORK_LINEAGE_REPEATED);
  });

  test("the database refuses the same three, as one ancestry violation", async () => {
    const message = await refusedByDatabase(() =>
      rawClient(harness).$executeRawUnsafe(
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
    const message = await refusedByStore(() =>
      harness.stores.turns.createTurn(scope, turnOf(chain, uuid("14"), threadId, 0)),
    );
    expect(message).toContain(SEQUENCE_OUT_OF_RANGE);
  });

  test("the store refuses a negative latency", async () => {
    const message = await refusedByStore(() =>
      harness.stores.turns.createTurn(
        scope,
        turnOf(chain, uuid("15"), threadId, 9, { latencyMs: -1 }),
      ),
    );
    expect(message).toContain(MEASUREMENT_NEGATIVE);
  });

  test("the store refuses a turn that completed before it started", async () => {
    const message = await refusedByStore(() =>
      harness.stores.turns.createTurn(
        scope,
        turnOf(chain, uuid("16"), threadId, 10, {
          startedAt: new Date(AT.getTime() + 1_000),
          completedAt: AT,
        }),
      ),
    );
    expect(message).toContain(TIMESTAMPS_INCOHERENT);
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
        rawClient(harness).$executeRawUnsafe(
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
      const message = await refusedByStore(() =>
        harness.stores.turns.createTurn(
          scope,
          turnOf(chain, uuid("1a"), threadId, 13, patch as Partial<Turn>),
        ),
      );
      expect(message).toContain(TURN_JSON_NOT_OBJECT);
    }
  });

  test("the database refuses an array in `Turn.input`", async () => {
    const message = await refusedByDatabase(() =>
      rawClient(harness).$executeRawUnsafe(
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
