// Every write GUARD over a `Step` or a `PostmanExecution`, stood beside the
// migration constraint it restates.
//
// SPLIT FROM `conversations-constraints.integration.test.ts` BECAUSE
// `max-file-lines` BIT AT THE HARD ERROR, and the seam it pointed at is real:
// that file is about the shapes a CONVERSATION admits, and this one is about the
// shapes a BILL and an OPERATOR'S AUDIT ROW admit. `Step_usage_check` ties
// thirteen columns to `costCents`; `PostmanExecution` carries two regular
// expressions and an ancestry rule that couples two of its foreign keys. Neither
// has anything to say about a thread.
//
// TWO HALVES PER CASE, as in its sibling: the STORE refuses with its own code,
// and the DATABASE refuses the same value with its constraint's name.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  asConversationsIdentifier,
  money,
  type EnvironmentScope,
  type ModelPriceId,
  type PostmanContextHandle,
  type ThreadId,
  type TurnId,
} from "@platos/context-conversations/application/ports/index.js";

import {
  CONTEXT_HANDLE_MALFORMED,
  CONVERSATIONS_IDENTIFIER_NOT_UUID,
  EXECUTION_TURN_WITHOUT_THREAD,
  REQUEST_FINGERPRINT_MALFORMED,
  SEQUENCE_OUT_OF_RANGE,
  STEP_CACHE_EXCEEDS_INPUT,
  STEP_PRICE_SNAPSHOT_INCOMPLETE,
  STEP_USAGE_NEGATIVE,
} from "./conversations-guards.js";
import {
  executionOf,
  fullRates,
  rawClient,
  refusedByDatabase,
  stepOf,
  threadOf,
  turnOf,
} from "./conversations-fixtures.js";
import type { ConversationsHarness, PeerChain } from "./conversations-harness.js";
import { startConversationsHarness } from "./conversations-harness.js";

let harness: ConversationsHarness;
let chain: PeerChain;
let scope: EnvironmentScope;
let threadId: ThreadId;
let turnId: TurnId;

const uuid = (tail: string) => `c6000000-0000-4000-8000-${tail.padStart(12, "0")}`;
const executionIds = (tail: string) => ({
  executionId: uuid(`3${tail}`),
  requestId: uuid(`4${tail}`),
  contextHandle: uuid(`5${tail}`),
});

async function refusedByStore(work: () => Promise<{ readonly ok: boolean }>): Promise<string> {
  const outcome = (await work()) as { ok: boolean; error?: { message: string } };
  if (outcome.ok) throw new Error("the store accepted a value the database refuses");
  return outcome.error?.message ?? "";
}

/** A settlement of ONE step against the turn this suite seeded. */
function settle(step: ReturnType<typeof stepOf>) {
  return harness.stores.turns.saveSettlement(scope, {
    turn: turnOf(chain, turnId, threadId, 1),
    steps: [step],
  });
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

describe("@db.Uuid on a step's price card", () => {
  test("the store refuses `price-1`, which the context's own stepFixture mints", async () => {
    const message = await refusedByStore(() =>
      settle(
        stepOf(uuid("21"), turnId, {
          modelPriceId: asConversationsIdentifier<ModelPriceId>("price-1"),
        }),
      ),
    );
    expect(message).toContain(CONVERSATIONS_IDENTIFIER_NOT_UUID);
  });
});

describe("Step_usage_check", () => {
  test("the store refuses a step sequence of zero", async () => {
    // `Step_usage_check` opens `"sequence" > 0 AND "retryCount" >= 0`, and the
    // sequence is what `@@unique([turnId, sequence])` orders a trace by.
    // `PRIMARY_STEP_SEQUENCE` is 1 because the row layout says so, and a step at
    // zero would sort in front of the turn's own model call.
    const message = await refusedByStore(() => settle(stepOf(uuid("22"), turnId, { sequence: 0 })));
    expect(message).toContain(SEQUENCE_OUT_OF_RANGE);
  });

  test("the store refuses a negative token count", async () => {
    const message = await refusedByStore(() =>
      settle(
        stepOf(uuid("23"), turnId, {
          usage: {
            inputTokens: -1,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            reasoningTokens: 0,
          },
        }),
      ),
    );
    expect(message).toContain(STEP_USAGE_NEGATIVE);
  });

  test("the store refuses cache figures that exceed the input total, under its OWN code", async () => {
    // THE ONE THE DOMAIN DOES NOT CATCH EITHER WAY. `domain/step-usage.ts` says
    // the two cache figures are PARTS of `inputTokens`; the constraint says so in
    // SQL; and a step whose cache reads exceed its input is a provider report
    // this system cannot charge for twice.
    const message = await refusedByStore(() =>
      settle(
        stepOf(uuid("24"), turnId, {
          usage: {
            inputTokens: 100,
            outputTokens: 0,
            cacheCreationInputTokens: 80,
            cacheReadInputTokens: 80,
            reasoningTokens: 0,
          },
        }),
      ),
    );
    expect(message).toContain(STEP_CACHE_EXCEEDS_INPUT);
  });

  // THE PRICE SNAPSHOT IS TWO GUARDS AND THEY ARE STOOD APART ON PURPOSE. A step
  // that carried neither a card nor its rates would be refused by whichever ran
  // first, so deleting either one would change nothing and both would be
  // unfalsifiable behind one case — which is exactly what the first mutation
  // sweep found. Each case below leaves the OTHER half satisfied.
  test("a priced step with full rates but NO card is refused", async () => {
    const message = await refusedByStore(() =>
      settle(
        stepOf(uuid("25"), turnId, {
          cost: money(4_500_000n),
          modelPriceId: null,
          rates: fullRates(),
        }),
      ),
    );
    expect(message).toContain(STEP_PRICE_SNAPSHOT_INCOMPLETE);
  });

  test("a priced step with a card but ONE rate missing is refused", async () => {
    const message = await refusedByStore(() =>
      settle(
        stepOf(uuid("26"), turnId, {
          cost: money(4_500_000n),
          modelPriceId: asConversationsIdentifier<ModelPriceId>(chain.modelPriceId),
          rates: Object.freeze({ ...fullRates(), cacheWrite: null }),
        }),
      ),
    );
    expect(message).toContain(STEP_PRICE_SNAPSHOT_INCOMPLETE);
  });

  test("the database refuses all three shapes, naming one constraint", async () => {
    for (const values of [
      { columns: `"inputTokens"`, values: `-1`, tail: "27" },
      {
        columns: `"inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"`,
        values: `100, 80, 80`,
        tail: "28",
      },
      { columns: `"costCents"`, values: `4.5`, tail: "29" },
    ]) {
      const message = await refusedByDatabase(() =>
        rawClient(harness).$executeRawUnsafe(
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
      const message = await refusedByStore(() =>
        harness.stores.postman.createExecution(scope, {
          ...executionOf(chain, executionIds("1")),
          requestFingerprint: fingerprint,
        }),
      );
      expect(message).toContain(REQUEST_FINGERPRINT_MALFORMED);
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
      const message = await refusedByStore(() =>
        harness.stores.postman.createExecution(scope, {
          ...executionOf(chain, executionIds("2")),
          contextHandle: asConversationsIdentifier<PostmanContextHandle>(handle),
        }),
      );
      expect(message).toContain(CONTEXT_HANDLE_MALFORMED);
    }
  });

  test("the database refuses both, naming its own constraint each time", async () => {
    const fingerprint = await refusedByDatabase(() =>
      rawClient(harness).$executeRawUnsafe(
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
      rawClient(harness).$executeRawUnsafe(
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
    const message = await refusedByStore(() =>
      harness.stores.postman.createExecution(scope, {
        ...executionOf(chain, executionIds("4")),
        turnId,
        threadId: null,
      }),
    );
    expect(message).toContain(EXECUTION_TURN_WITHOUT_THREAD);
  });

  test("the database refuses it as an ancestry violation, naming neither column", async () => {
    const message = await refusedByDatabase(() =>
      rawClient(harness).$executeRawUnsafe(
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
