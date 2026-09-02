// WIN-284 — the engine's refusals.
//
// Everything here is about the engine declining to report parity it did not
// measure. Each test names the specific way a differential harness goes quietly
// vacuous and proves this one refuses it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { baselineObservation } from "./seeds.mjs";
import { countComparableFacts, validateObservation } from "./observation.mjs";
import { formatResult, partitionApprovals, twinRun } from "./twin-run.mjs";

const ALL_DIMENSIONS = ["status", "schema", "events", "auth", "sideEffects", "usage", "store"];
const scenario = (overrides = {}) => ({ id: "engine-probe", dimensions: ALL_DIMENSIONS, ...overrides });
const subject = (side, patch = (observation) => observation) => ({
  async run(target) {
    return patch({ ...JSON.parse(JSON.stringify(baselineObservation(side))), scenario: target.id });
  },
});

test("a clean twin-run over isolated stores reports parity and says how much it compared", async () => {
  const result = await twinRun(scenario(), { oracle: subject("oracle"), candidate: subject("candidate") });
  assert.equal(result.verdict, "parity");
  assert.deepEqual(Object.keys(result.factCounts).sort(), [...ALL_DIMENSIONS].sort());
  for (const [dimension, counts] of Object.entries(result.factCounts)) {
    assert.ok(counts.oracle > 0 && counts.candidate > 0, `${dimension} compared nothing`);
  }
});

test("VACUITY: a dimension with no facts on either side is refused, not reported as parity", async () => {
  const stripEvents = (observation) => ({ ...observation, events: [] });
  const result = await twinRun(scenario({ dimensions: ["events"] }), {
    oracle: subject("oracle", stripEvents),
    candidate: subject("candidate", stripEvents),
  });
  assert.equal(result.verdict, "vacuous");
  assert.match(result.failures[0], /silence, not parity/u);
});

test("VACUITY: a dimension present on one side only is still refused", async () => {
  const result = await twinRun(scenario({ dimensions: ["events"] }), {
    oracle: subject("oracle"),
    candidate: subject("candidate", (observation) => ({ ...observation, events: [] })),
  });
  assert.equal(result.verdict, "vacuous");
});

test("VACUITY: a subject that meters nothing makes the usage dimension vacuous", async () => {
  const unmetered = (observation) => ({ ...observation, usage: { ...observation.usage, measured: [] } });
  const result = await twinRun(scenario({ dimensions: ["usage"] }), {
    oracle: subject("oracle", unmetered),
    candidate: subject("candidate", unmetered),
  });
  assert.equal(result.verdict, "vacuous", "three zeroes nobody measured is not agreement about usage");
});

test("VACUITY: a store comparison with an unnamed store is refused, not assumed isolated", async () => {
  // Omission is the easiest way for a guard to stop guarding. A subject that
  // simply leaves `storeIdentity` off would otherwise skip the isolation check
  // entirely and the run would report parity over stores nobody checked were
  // separate.
  const anonymous = (observation) => {
    const next = { ...observation };
    delete next.storeIdentity;
    return next;
  };
  const result = await twinRun(scenario({ dimensions: ["store"] }), {
    oracle: subject("oracle", anonymous),
    candidate: subject("candidate", anonymous),
  });
  assert.equal(result.verdict, "invalid");
  assert.match(result.failures[0], /isolation is assumed rather than checked/u);

  // One side naming its store is still not enough.
  const halfNamed = await twinRun(scenario({ dimensions: ["store"] }), {
    oracle: subject("oracle"),
    candidate: subject("candidate", anonymous),
  });
  assert.equal(halfNamed.verdict, "invalid");
});

test("an empty store identity is rejected, because it would compare equal on both sides", () => {
  const observation = { ...baselineObservation("oracle"), storeIdentity: "" };
  assert.ok(validateObservation(observation).some((error) => error.includes("storeIdentity")));
});

test("VACUITY: two sides pointed at the same store cannot diverge and are refused", async () => {
  const shared = (side) => subject(side, (observation) => ({ ...observation, storeIdentity: "one-store" }));
  const result = await twinRun(scenario(), { oracle: shared("oracle"), candidate: shared("candidate") });
  assert.equal(result.verdict, "invalid");
  assert.match(result.failures[0], /twin-running one store against itself/u);
});

test("VACUITY: a scenario that declares no dimensions is refused", async () => {
  const result = await twinRun({ id: "empty", dimensions: [] }, {
    oracle: subject("oracle"),
    candidate: subject("candidate"),
  });
  assert.equal(result.verdict, "unsound");
  assert.match(result.failures.join(" "), /compare nothing/u);
});

test("a malformed observation is rejected rather than defaulted into a comparable shape", async () => {
  const result = await twinRun(scenario(), {
    oracle: subject("oracle"),
    candidate: { async run() { return { scenario: "engine-probe", side: "candidate", subject: "broken" }; } },
  });
  assert.equal(result.verdict, "invalid");
});

test("mislabelled sides are refused", async () => {
  const result = await twinRun(scenario(), { oracle: subject("candidate"), candidate: subject("candidate") });
  assert.equal(result.verdict, "invalid");
  assert.match(result.failures[0], /mislabelled/u);
});

test("a subject that throws produces an invalid verdict, never a silent skip", async () => {
  const result = await twinRun(scenario(), {
    oracle: subject("oracle"),
    candidate: { async run() { throw new Error("the candidate never came up"); } },
  });
  assert.equal(result.verdict, "invalid");
  assert.match(result.failures[0], /never came up/u);
});

// ---------------------------------------------------------------------------
// Approved differences: reported, never hidden; and never left standing
// ---------------------------------------------------------------------------

test("an approved difference is reported as approved and does not fail the run", async () => {
  const result = await twinRun(
    scenario({
      approvedDifferences: [
        {
          code: "status-changed",
          rationale: "the V1 surface answers 201 on create by design, recorded on the issue as an intentional change",
          issue: "WIN-284",
        },
      ],
    }),
    {
      oracle: subject("oracle"),
      candidate: subject("candidate", (observation) => ({
        ...observation,
        response: { ...observation.response, status: 201 },
      })),
    },
  );
  assert.equal(result.verdict, "parity");
  assert.equal(result.approved.length, 1);
  assert.equal(result.approved[0].approval.issue, "WIN-284");
  assert.match(formatResult(result), /APPROVED/u);
});

test("an approval that never matches is a permanent mute and fails the run", async () => {
  const result = await twinRun(
    scenario({
      approvedDifferences: [
        {
          code: "status-changed",
          rationale: "an approval retained after the difference it covered was already resolved upstream",
          issue: "WIN-284",
        },
      ],
    }),
    { oracle: subject("oracle"), candidate: subject("candidate") },
  );
  assert.equal(result.verdict, "stale-approval");
});

test("an approval without a rationale or an issue is refused", async () => {
  for (const approval of [
    { code: "status-changed", rationale: "too short", issue: "WIN-284" },
    { code: "status-changed", rationale: "a long enough rationale that explains the intentional difference", issue: "nope" },
  ]) {
    const result = await twinRun(scenario({ approvedDifferences: [approval] }), {
      oracle: subject("oracle"),
      candidate: subject("candidate"),
    });
    assert.equal(result.verdict, "unsound");
  }
});

test("approvals are consumed one-for-one, so a second unapproved occurrence still fails", () => {
  const divergences = [
    { code: "status-changed", path: "response.status", dimension: "status" },
    { code: "status-changed", path: "response.status", dimension: "status" },
  ];
  const { approved, unapproved, stale } = partitionApprovals(divergences, [
    { code: "status-changed", rationale: "one occurrence is authorised and the second is not", issue: "WIN-284" },
  ]);
  assert.equal(approved.length, 1);
  assert.equal(unapproved.length, 1);
  assert.equal(stale.length, 0);
});

test("a contract-bearing header can never be declared volatile by a scenario", async () => {
  const result = await twinRun(scenario({ volatileHeaders: ["content-type"] }), {
    oracle: subject("oracle"),
    candidate: subject("candidate"),
  });
  assert.equal(result.verdict, "unsound");
  assert.match(result.failures.join(" "), /cannot be declared volatile/u);
});

test("a scenario that asks for events to be order-normalised is refused", async () => {
  const result = await twinRun(scenario({ unorderedCollections: ["events"] }), {
    oracle: subject("oracle"),
    candidate: subject("candidate"),
  });
  assert.equal(result.verdict, "unsound");
  assert.match(result.failures.join(" "), /seeded divergence this harness must detect/u);
});

// ---------------------------------------------------------------------------
// Fact counting
// ---------------------------------------------------------------------------

test("countComparableFacts returns zero exactly when a dimension is empty", () => {
  const observation = baselineObservation("oracle");
  for (const dimension of ALL_DIMENSIONS) assert.ok(countComparableFacts(observation, dimension) > 0);
  assert.equal(countComparableFacts({ ...observation, events: [] }, "events"), 0);
  assert.equal(countComparableFacts({ ...observation, sideEffects: [] }, "sideEffects"), 0);
  assert.equal(countComparableFacts({ ...observation, store: {} }, "store"), 0);
  // auth is never zero: an unauthenticated call is itself an auth fact.
  assert.ok(
    countComparableFacts({ ...observation, auth: { principal: null, scopes: [], decision: "deny", reason: null } }, "auth") > 0,
  );
});

test("countComparableFacts refuses an unknown dimension", () => {
  assert.throws(() => countComparableFacts(baselineObservation("oracle"), "invented"), /unknown dimension/u);
});

test("validateObservation names every missing field rather than failing on the first", () => {
  const errors = validateObservation({ scenario: "x", side: "oracle", subject: "y" });
  assert.ok(errors.length >= 5, `expected several errors, saw ${JSON.stringify(errors)}`);
});

test("an absent response body is an error, because absent and null are different facts", () => {
  const observation = baselineObservation("oracle");
  delete observation.response.body;
  assert.ok(validateObservation(observation).some((error) => error.includes("response.body")));
});
