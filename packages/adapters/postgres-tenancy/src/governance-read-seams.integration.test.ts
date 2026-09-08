// The three `governance` read seams, against a real PostgreSQL, with TWO tenants.
//
// WHY A SECOND TENANT IS THE WHOLE SUITE. Every case here that matters is a
// NEGATIVE one, and a negative case over one tenant is unfalsifiable: "the
// foreign turn was not returned" is equally true of a reader that narrows and of
// a reader that was never given a foreign turn to return. `governance-harness.ts`
// seeds `foreignChain()` — a whole second organization, project, environment,
// agent, end user, thread and two turns — and every read below is issued TWICE,
// once with each scope, against identifiers from the OTHER one.
//
// AND WHY IT CANNOT BE A DOUBLE. `Turn` has no `environmentId` column. Its
// tenancy is a JOIN, and the defect this suite exists to catch —
// `turn.findUnique({ where: { id } })`, which type-checks and answers with any
// tenant's turn — is invisible to `InMemoryRatingTargets`, which stores an
// `environmentId` beside every seeded turn precisely because it has nowhere else
// to put one. The double cannot have this bug. Only the database can.
//
// THE PEER ROWS ARE SEEDED THROUGH THE ORM'S CLI, not through this package's
// ports. `governance-harness.ts` gives the reason for `Thread` and `Turn`
// (`sole-writer.mjs` refuses a write to another owner's row from the
// `governance` tag, correctly) and it extends unchanged to `ToolCallAudit` and
// `AgentApproval`: they are `tools`' and `jobs`' rows, and this suite is not
// testing either context's repository.
//
// THE WINDOW IS PINNED EITHER SIDE OF THE HARNESS STAMP. Every seeded row is
// stamped `2026-05-01T09:00:00Z` by `governance-harness.ts`; the rows this file
// adds are stamped relative to that, so `since` can be asserted from BOTH sides
// rather than only from below.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  EnvironmentScope,
  ThreadId,
  TurnId,
} from "@platos/context-governance/application/ports/index.js";
import {
  asGovernanceIdentifier,
  asIdentifier,
  environmentScope,
} from "@platos/context-governance/application/ports/index.js";

import type { GovernanceReadSeams } from "./governance-read-seams.js";
import type { GovernanceHarness, PeerChain } from "./governance-harness.js";
import { startGovernanceHarness } from "./governance-harness.js";

let harness: GovernanceHarness;
let seams: GovernanceReadSeams;
let home: PeerChain;
let foreign: PeerChain;

/** Before every seeded row. `governance-harness.ts` stamps them at 09:00:00Z. */
const BEFORE_EVERYTHING = new Date("2026-05-01T00:00:00.000Z");
/** After every seeded row, so a window can be closed from above as well. */
const AFTER_EVERYTHING = new Date("2026-05-02T00:00:00.000Z");

const STAMP = "'2026-05-01T09:00:00Z'";
/** A row deliberately older than the window every case below asks for. */
const STALE = "'2026-04-01T09:00:00Z'";

function turnId(value: string): TurnId {
  return asGovernanceIdentifier<TurnId>(value);
}

function threadId(value: string): ThreadId {
  return asGovernanceIdentifier<ThreadId>(value);
}

/**
 * The same tenant, with the environment replaced by a value no column can hold.
 *
 * `EnvironmentScope`'s identifiers are BRANDS over `string`, so this is a scope
 * a caller could really build — and it is the one the three seams must refuse
 * rather than answer emptily.
 */
function unnarrowableScope(scope: EnvironmentScope): EnvironmentScope {
  return environmentScope(
    asIdentifier(scope.organizationId),
    asIdentifier(scope.projectId),
    asIdentifier(""),
  );
}

/**
 * A REAL environment under SOMEBODY ELSE'S project and organization.
 *
 * Every identifier in it exists; only the RELATION between them is a lie. This
 * is the scope `apps/agent/src/evals/rating.service.ts`' `threadScopeWhere`
 * refuses and an environment-only filter serves, and it can only be built with
 * two tenants on the table at once.
 */
function tamperedScope(own: EnvironmentScope, other: EnvironmentScope): EnvironmentScope {
  return environmentScope(
    asIdentifier(other.organizationId),
    asIdentifier(other.projectId),
    asIdentifier(own.environmentId),
  );
}

/** Tool calls and approvals for one chain, so the denominators have something to count. */
function activitySql(chain: PeerChain): string {
  const suffix = chain.agentId.slice(-12);
  return `
    INSERT INTO "ToolCallAudit"
      ("id", "environmentId", "agentId", "threadId", "toolName", "arguments",
       "status", "latencyMs", "createdAt")
    VALUES
      ('11111111-1111-4111-8111-${suffix}', '${chain.scope.environmentId}', '${chain.agentId}',
       '${chain.threadId}', 'lookup', '{}'::jsonb, 'FAILED', 12, ${STAMP}),
      ('22222222-2222-4222-8222-${suffix}', '${chain.scope.environmentId}', '${chain.agentId}',
       '${chain.threadId}', 'lookup', '{}'::jsonb, 'FAILED', 15, ${STAMP}),
      -- CANCELLED, which the ORACLE counts as a tool error alongside FAILED:
      -- apps/agent/src/monitoring/governance.service.ts, byte-identical to
      -- origin/main. Seeded so "FAILED alone" is a mutation a case can kill.
      ('77777777-7777-4777-8777-${suffix}', '${chain.scope.environmentId}', '${chain.agentId}',
       '${chain.threadId}', 'lookup', '{}'::jsonb, 'CANCELLED', 11, ${STAMP}),
      -- SUCCEEDED, so it must NOT be counted: the port's field is toolErrors.
      ('33333333-3333-4333-8333-${suffix}', '${chain.scope.environmentId}', '${chain.agentId}',
       '${chain.threadId}', 'lookup', '{}'::jsonb, 'SUCCEEDED', 9, ${STAMP}),
      -- FAILED but OUTSIDE the window, so the \`since\` bound has something to exclude.
      ('44444444-4444-4444-8444-${suffix}', '${chain.scope.environmentId}', '${chain.agentId}',
       '${chain.threadId}', 'lookup', '{}'::jsonb, 'FAILED', 20, ${STALE});

    INSERT INTO "AgentApproval"
      ("id", "environmentId", "agentId", "threadId", "turnId", "action", "status",
       "timeoutSeconds", "createdAt", "updatedAt")
    VALUES
      ('55555555-5555-4555-8555-${suffix}', '${chain.scope.environmentId}', '${chain.agentId}',
       '${chain.threadId}', '${chain.turnId}', 'send_email', 'PENDING', 300, ${STAMP}, ${STAMP}),
      -- RESOLVED as well as pending: the port counts approval EVENTS, not open ones.
      ('66666666-6666-4666-8666-${suffix}', '${chain.scope.environmentId}', '${chain.agentId}',
       '${chain.threadId}', '${chain.turnId}', 'send_email', 'APPROVED', 300, ${STAMP}, ${STAMP});
  `;
}

/** A third turn on the home thread, CANCELLED, so the transcript has one to drop. */
function cancelledTurnSql(chain: PeerChain, id: string): string {
  return `INSERT INTO "Turn" ("id", "threadId", "agentVersionId", "versionBucket", "sequence",
                              "inputText", "outputText", "status", "createdAt")
          VALUES ('${id}', '${chain.threadId}', '${chain.agentVersionId}', 'CURRENT', 3,
                  'abandoned question', NULL, 'CANCELLED', ${STAMP});`;
}

let cancelledTurnId: string;

beforeAll(async () => {
  harness = await startGovernanceHarness();
  seams = harness.base.adapter as unknown as GovernanceReadSeams;
  home = await harness.seedChain(await harness.freshScope());
  foreign = await harness.foreignChain();
  cancelledTurnId = harness.base.freshId("00c1");
  harness.applyPeerRows(cancelledTurnSql(home, cancelledTurnId));
  harness.applyPeerRows(activitySql(home));
  harness.applyPeerRows(activitySql(foreign));
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("RatingTargetReader", () => {
  test("resolves a turn in scope, attributing it to the THREAD's agent and subject", async () => {
    const found = await seams.ratingTargets.find(home.scope, turnId(home.turnId));
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).not.toBeNull();
    expect(found.value?.turnId).toBe(home.turnId);
    expect(found.value?.threadId).toBe(home.threadId);
    expect(found.value?.agentId).toBe(home.agentId);
    expect(found.value?.endUserId).toBe(home.endUserId);
    // FROM THE TURN, not from the agent's live binding. The second turn was
    // seeded against the SECOND version, so a reader that took the version from
    // the agent rather than from the turn would answer the same value twice.
    expect(found.value?.agentVersionId).toBe(home.agentVersionId);
    const second = await seams.ratingTargets.find(home.scope, turnId(home.secondTurnId));
    expect(second.ok && second.value?.agentVersionId).toBe(home.secondAgentVersionId);
  });

  test("a turn in ANOTHER tenant is null, not the row", async () => {
    // THE CENTRAL CASE. `Turn` has no environment column, so this is exactly the
    // read that answers with a foreign row when the join is missing. Both
    // directions, because a narrowing that works one way and not the other is a
    // narrowing that was written against one fixture.
    const outward = await seams.ratingTargets.find(home.scope, turnId(foreign.turnId));
    expect(outward.ok).toBe(true);
    expect(outward.ok && outward.value).toBeNull();

    const inward = await seams.ratingTargets.find(foreign.scope, turnId(home.turnId));
    expect(inward.ok).toBe(true);
    expect(inward.ok && inward.value).toBeNull();

    // AND THE FOREIGN SCOPE CAN SEE ITS OWN. Without this the two assertions
    // above would pass against a reader that returns null for everything.
    const own = await seams.ratingTargets.find(foreign.scope, turnId(foreign.turnId));
    expect(own.ok && own.value?.turnId).toBe(foreign.turnId);
  });

  test("a mistyped turn id is ABSENT, not an error", async () => {
    const found = await seams.ratingTargets.find(home.scope, turnId("not-a-uuid"));
    expect(found.ok).toBe(true);
    expect(found.ok && found.value).toBeNull();
  });

  test("a scope with no environment to narrow by REFUSES, under its own code", async () => {
    const found = await seams.ratingTargets.find(unnarrowableScope(home.scope), turnId(home.turnId));
    expect(found.ok).toBe(false);
    expect(!found.ok && found.error.code).toBe("GOVERNANCE_RATING_TARGET_UNREADABLE");
  });

  test("a REAL environment under a FOREIGN project is null — the whole triple narrows", async () => {
    // THE ORACLE'S EXTRA CLAUSES, PROVED. `threadScopeWhere` in
    // `apps/agent/src/evals/rating.service.ts` narrows by organization, project
    // AND environment; an environment-only filter serves this scope, because
    // the environment really does contain the turn. Every identifier below
    // exists — only the relation between them is a lie.
    const found = await seams.ratingTargets.find(
      tamperedScope(home.scope, foreign.scope),
      turnId(home.turnId),
    );
    expect(found.ok).toBe(true);
    expect(found.ok && found.value).toBeNull();
  });
});

describe("TranscriptReader", () => {
  test("reads the thread in conversation order, without the cancelled turn", async () => {
    const read = await seams.transcripts.read(home.scope, threadId(home.threadId), null);
    expect(read.ok).toBe(true);
    if (!read.ok || read.value === null) throw new Error("expected a transcript");
    expect(read.value.threadId).toBe(home.threadId);
    expect(read.value.agentId).toBe(home.agentId);
    expect(read.value.turns.map((turn) => turn.turnId)).toEqual([home.turnId, home.secondTurnId]);
    expect(read.value.turns.map((turn) => turn.input)).toEqual([
      "what is the refund window",
      "and for opened items",
    ]);
    expect(read.value.turns.map((turn) => turn.output)).toEqual(["thirty days", "fourteen days"]);
    // THE CANCELLED TURN IS SEEDED AND EXCLUDED. Without the seed the port's
    // "a cancelled turn is not included" would be a claim about an empty set.
    expect(read.value.turns.map((turn) => turn.turnId)).not.toContain(cancelledTurnId);
    // AND ITS VERSIONS TRAVEL, which is what `versionUnderTest` divides on.
    expect(read.value.turns.map((turn) => turn.agentVersionId)).toEqual([
      home.agentVersionId,
      home.secondAgentVersionId,
    ]);
  });

  test("a thread in ANOTHER tenant is null, and its own scope can still read it", async () => {
    const outward = await seams.transcripts.read(home.scope, threadId(foreign.threadId), null);
    expect(outward.ok && outward.value).toBeNull();
    const own = await seams.transcripts.read(foreign.scope, threadId(foreign.threadId), null);
    expect(own.ok && own.value?.turns).toHaveLength(2);
  });

  test("a named turn narrows to one exchange", async () => {
    const read = await seams.transcripts.read(
      home.scope,
      threadId(home.threadId),
      turnId(home.secondTurnId),
    );
    expect(read.ok).toBe(true);
    if (!read.ok || read.value === null) throw new Error("expected a transcript");
    expect(read.value.turns.map((turn) => turn.turnId)).toEqual([home.secondTurnId]);
  });

  test("a named turn from ANOTHER THREAD yields an empty list, not the whole thread", async () => {
    // THE PORT'S OWN WORDS: "a mistyped id cannot silently widen what a judge is
    // paid to read". The id used here is REAL — the foreign tenant's turn — so a
    // reader that dropped the `id` filter on a miss would answer with this
    // thread's two turns and be paid to score them.
    const read = await seams.transcripts.read(
      home.scope,
      threadId(home.threadId),
      turnId(foreign.turnId),
    );
    expect(read.ok).toBe(true);
    if (!read.ok || read.value === null) throw new Error("expected a transcript");
    expect(read.value.threadId).toBe(home.threadId);
    expect(read.value.turns).toHaveLength(0);
  });

  test("a mistyped turn id yields an empty list too", async () => {
    const read = await seams.transcripts.read(
      home.scope,
      threadId(home.threadId),
      turnId("not-a-uuid"),
    );
    expect(read.ok).toBe(true);
    expect(read.ok && read.value?.turns).toHaveLength(0);
  });

  test("a scope with no environment to narrow by REFUSES, under its own code", async () => {
    const read = await seams.transcripts.read(
      unnarrowableScope(home.scope),
      threadId(home.threadId),
      null,
    );
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error.code).toBe("GOVERNANCE_TRANSCRIPT_UNREADABLE");
  });

  test("a REAL environment under a FOREIGN project is null — the whole triple narrows", async () => {
    const read = await seams.transcripts.read(
      tamperedScope(home.scope, foreign.scope),
      threadId(home.threadId),
      null,
    );
    expect(read.ok).toBe(true);
    expect(read.ok && read.value).toBeNull();
  });
});

describe("ActivityReader", () => {
  test("counts turns, tool failures and approvals for THIS environment's agents", async () => {
    const counted = await seams.activity.countByAgent(home.scope, BEFORE_EVERYTHING);
    expect(counted.ok).toBe(true);
    if (!counted.ok) return;
    const row = counted.value.find((candidate) => candidate.agentId === home.agentId);
    expect(row).toBeDefined();
    // THREE turns: two SUCCEEDED and the CANCELLED one. The denominator is
    // "how much did this agent do", not "how much did it finish" — `risk.ts`
    // divides safety events by it, and a cancelled turn can carry one.
    expect(row?.turns).toBe(3);
    // THREE of the five seeded tool calls: two FAILED and one CANCELLED, which
    // is the ORACLE's definition of a tool error. The SUCCEEDED one and the
    // FAILED one outside the window are excluded, for two different reasons.
    expect(row?.toolErrors).toBe(3);
    expect(row?.approvalEvents).toBe(2);

    // AND THE FOREIGN AGENT IS NOT ON THIS BOARD AT ALL. Its rows exist and are
    // identical in shape, so a missing narrowing on ANY of the three statements
    // would put it here.
    expect(counted.value.map((candidate) => candidate.agentId)).not.toContain(foreign.agentId);
  });

  test("each of the three counts is narrowed SEPARATELY", async () => {
    // The three sources narrow by three different mechanisms — `Turn` through a
    // JOIN on `Thread.environmentId`, the other two on their own column — so a
    // single assertion on the row above could pass with one of them wrong if the
    // other two happened to dominate. This reads the foreign board and asserts
    // it holds exactly its OWN counts, which can only be true if all three
    // statements narrow.
    const counted = await seams.activity.countByAgent(foreign.scope, BEFORE_EVERYTHING);
    expect(counted.ok).toBe(true);
    if (!counted.ok) return;
    expect(counted.value).toHaveLength(1);
    const row = counted.value[0];
    expect(row?.agentId).toBe(foreign.agentId);
    // TWO, not three: the cancelled turn was seeded on the HOME thread only.
    expect(row?.turns).toBe(2);
    expect(row?.toolErrors).toBe(3);
    expect(row?.approvalEvents).toBe(2);
  });

  test("`since` closes the window from below", async () => {
    const counted = await seams.activity.countByAgent(home.scope, AFTER_EVERYTHING);
    expect(counted.ok).toBe(true);
    expect(counted.ok && counted.value).toHaveLength(0);
  });

  test("a scope with no environment to narrow by REFUSES rather than answering []", async () => {
    // THE MOST DANGEROUS OF THE THREE TO GET WRONG. `risk-report.ts` does not
    // refuse on an activity failure — it renders the board with every
    // denominator substituted and `complete: false`. An empty list here would be
    // indistinguishable from a quiet installation.
    const counted = await seams.activity.countByAgent(
      unnarrowableScope(home.scope),
      BEFORE_EVERYTHING,
    );
    expect(counted.ok).toBe(false);
    expect(!counted.ok && counted.error.code).toBe("GOVERNANCE_ACTIVITY_UNREADABLE");
  });

  test("a REAL environment under a FOREIGN project counts NOTHING", async () => {
    // ALL THREE STATEMENTS, not one: the turn count reaches the project through
    // two extra JOINs and the other two through one relation, so a triple
    // enforced on the grouped reads and dropped from the raw one would leave
    // `turns` populated here and the other two at zero.
    const counted = await seams.activity.countByAgent(
      tamperedScope(home.scope, foreign.scope),
      BEFORE_EVERYTHING,
    );
    expect(counted.ok).toBe(true);
    expect(counted.ok && counted.value).toHaveLength(0);
  });
});

test("the three seams refuse under three DISTINCT codes", async () => {
  // Two guards sharing a code cannot be told apart, and these three are raised
  // by the same guard over the same value — which is exactly the shape that
  // collapses into one code by accident. Asserted over the LIVE objects rather
  // than over the catalogue, so a seam wired to the wrong constructor fails here.
  const scope = unnarrowableScope(home.scope);
  const results = await Promise.all([
    seams.ratingTargets.find(scope, turnId(home.turnId)),
    seams.transcripts.read(scope, threadId(home.threadId), null),
    seams.activity.countByAgent(scope, BEFORE_EVERYTHING),
  ]);
  const codes = results.map((result) => (result.ok ? "ok" : result.error.code));
  expect(new Set(codes).size).toBe(3);
  expect(codes).not.toContain("GOVERNANCE_LEDGER_UNAVAILABLE");
});
