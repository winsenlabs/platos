// WIN-284 — comparator behaviour, including the branches that must NOT fire.
//
// A comparator that reports a divergence for everything is as useless as one
// that reports none, so every "it catches X" assertion here is paired with an
// "it stays quiet on Y" assertion.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONTRACT_HEADERS,
  DIVERGENCE_CODES,
  MAX_RELATIVE_TOLERANCE,
  assertComparatorCoverage,
  assertTolerance,
  assertVolatileHeaders,
  compareAuth,
  compareEvents,
  compareSchema,
  compareSideEffects,
  compareStatus,
  compareStore,
  compareUsage,
  leafValues,
  schemaSignature,
} from "./comparators.mjs";
import { DIMENSIONS } from "./observation.mjs";
import { baselineObservation } from "./seeds.mjs";

// Comparators are specified against NORMALISED observations, so these unit
// tests hold the nondeterministic fields constant by using one side's fixture
// for both inputs and introducing exactly one patch. Using the oracle and
// candidate fixtures here instead would inject the identifier and clock
// differences the register exists to erase, and every assertion would be
// measuring the fixtures rather than the comparator. The register's own
// behaviour on that pair is proven separately in normalisers.test.mjs.
const reference = () => JSON.parse(JSON.stringify(baselineObservation("candidate")));

function withPatch(patch) {
  const next = reference();
  patch(next);
  return next;
}

test("every acceptance dimension has a comparator and every comparator is an acceptance dimension", () => {
  assert.deepEqual(assertComparatorCoverage(), []);
  assert.deepEqual([...DIMENSIONS].sort(), ["auth", "events", "schema", "sideEffects", "status", "store", "usage"]);
});

test("divergence codes are unique", () => {
  assert.equal(new Set(DIVERGENCE_CODES).size, DIVERGENCE_CODES.length);
});

test("status: equal statuses are quiet, different statuses are not", () => {
  assert.deepEqual(compareStatus(reference(), withPatch(() => {})), []);
  const found = compareStatus(reference(), withPatch((observation) => { observation.response.status = 500; }));
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "status-changed");
});

test("schema: a value change with an identical shape is still caught", () => {
  // The failure this guards against: comparing only the shape, so a body that
  // is structurally perfect and semantically wrong reads as parity.
  const found = compareSchema(reference(), withPatch((observation) => { observation.response.body.name = "different"; }));
  assert.deepEqual(found.map((entry) => entry.code), ["schema-value-changed"]);
});

test("schema: an array that loses an element reports the exact position", () => {
  const found = compareSchema(reference(), withPatch((observation) => { observation.response.body.labels.pop(); }));
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "schema-field-missing");
  assert.equal(found[0].path, "$.labels[1]");
});

test("schema: headers are part of the contract", () => {
  const missing = compareSchema(reference(), withPatch((observation) => { delete observation.response.headers["content-type"]; }));
  assert.deepEqual(missing.map((entry) => entry.code), ["header-missing"]);

  const added = compareSchema(reference(), withPatch((observation) => { observation.response.headers["x-new"] = "1"; }));
  assert.deepEqual(added.map((entry) => entry.code), ["header-added"]);
});

test("schema: a header declared volatile is skipped, but a contract header can never be declared volatile", () => {
  const quiet = compareSchema(
    reference(),
    withPatch((observation) => { observation.response.headers["x-request-ordinal"] = "7"; }),
    { volatileHeaders: ["x-request-ordinal"] },
  );
  assert.deepEqual(quiet, []);

  for (const header of CONTRACT_HEADERS) {
    assert.throws(() => assertVolatileHeaders([header]), /cannot be declared volatile/u, `${header} must be protected`);
  }
  assert.throws(() => assertVolatileHeaders(["Content-Type"]), /cannot be declared volatile/u, "matching is case-insensitive");
});

test("events: a reordering is reported as a reordering, not as a drop plus an add", () => {
  const reordered = withPatch((observation) => {
    const [first, second] = observation.events;
    observation.events[0] = second;
    observation.events[1] = first;
  });
  const found = compareEvents(reference(), reordered);
  assert.ok(found.some((entry) => entry.code === "event-reordered"), JSON.stringify(found));
  assert.ok(!found.some((entry) => entry.code === "event-missing"));
});

test("events: identical logs are quiet", () => {
  assert.deepEqual(compareEvents(reference(), reference()), []);
});

test("auth: a widened scope is caught in the dangerous direction as well as the safe one", () => {
  const widened = compareAuth(reference(), withPatch((observation) => { observation.auth.scopes.push("records.admin"); }));
  assert.deepEqual(widened.map((entry) => entry.code), ["auth-scope-added"]);

  const narrowed = compareAuth(reference(), withPatch((observation) => { observation.auth.scopes = ["records.read"]; }));
  assert.deepEqual(narrowed.map((entry) => entry.code), ["auth-scope-missing"]);
});

test("auth: scope order is not a difference", () => {
  const reordered = withPatch((observation) => { observation.auth.scopes = ["records.write", "records.read"]; });
  assert.deepEqual(compareAuth(reference(), reordered), []);
});

test("sideEffects: order is not a difference but membership is", () => {
  const reordered = withPatch((observation) => { observation.sideEffects.reverse(); });
  assert.deepEqual(compareSideEffects(reference(), reordered), []);

  const dropped = compareSideEffects(reference(), withPatch((observation) => { observation.sideEffects.pop(); }));
  assert.deepEqual(dropped.map((entry) => entry.code), ["side-effect-missing"]);
});

test("usage: the tolerance ceiling refuses a tolerance wide enough to stop measuring", () => {
  assert.throws(() => assertTolerance({ costMicros: 0.5 }), /exceeds the .* ceiling/u);
  assert.throws(() => assertTolerance({ costMicros: -1 }), /non-negative/u);
  assert.deepEqual(assertTolerance({ costMicros: MAX_RELATIVE_TOLERANCE }).costMicros, MAX_RELATIVE_TOLERANCE);
});

test("usage: cost within the ceiling is quiet, cost beyond it is not", () => {
  const inside = compareUsage(reference(), withPatch((observation) => { observation.usage.costMicros = 909; }), {
    tolerance: { costMicros: 0.01 },
  });
  assert.deepEqual(inside, []);

  const outside = compareUsage(reference(), withPatch((observation) => { observation.usage.costMicros = 945; }), {
    tolerance: { costMicros: 0.01 },
  });
  assert.deepEqual(outside.map((entry) => entry.code), ["cost-changed"]);
});

test("usage: an unmeasured component is not compared, and dropping it is itself a divergence", () => {
  // The hole this closes: a subject that does not model cost reports
  // `costMicros: 0`, both sides "agree" on zero, and the usage dimension
  // records agreement about a number neither side measured.
  const unmetered = withPatch((observation) => {
    observation.usage.measured = ["inputUnits", "outputUnits"];
    observation.usage.costMicros = 999999;
  });
  const found = compareUsage(reference(), unmetered);
  assert.deepEqual(found.map((entry) => entry.code), ["usage-measurement-changed"]);
  assert.ok(
    !found.some((entry) => entry.path === "usage.costMicros"),
    "a component neither side agreed to meter must not be compared as if it were",
  );

  // Two sides that both meter only units compare those units and nothing else.
  const bothUnmetered = (value) =>
    withPatch((observation) => {
      observation.usage.measured = ["inputUnits", "outputUnits"];
      observation.usage.costMicros = value;
    });
  assert.deepEqual(compareUsage(bothUnmetered(0), bothUnmetered(500)), []);
});

test("usage: the default tolerance is exact", () => {
  const found = compareUsage(reference(), withPatch((observation) => { observation.usage.costMicros = 901; }));
  assert.deepEqual(found.map((entry) => entry.code), ["cost-changed"]);
});

test("store: row order is not a difference but row content is", () => {
  const reordered = withPatch((observation) => { observation.store.record.reverse(); });
  assert.deepEqual(compareStore(reference(), reordered), []);

  const changed = withPatch((observation) => { observation.store.record[0].revision = 99; });
  const found = compareStore(reference(), changed);
  assert.deepEqual(found.map((entry) => entry.code).sort(), ["store-row-extra", "store-row-missing"]);
});

test("schemaSignature and leafValues agree on the path grammar", () => {
  const body = { a: 1, b: [true, null], c: {} };
  assert.deepEqual([...schemaSignature(body, "$").keys()].sort(), [...leafValues(body, "$").keys()].sort());
});

test("an empty object and an empty array are leaves, not absences", () => {
  assert.deepEqual([...schemaSignature({ a: {}, b: [] }, "$")], [["$.a", "object:empty"], ["$.b", "array:empty"]]);
});
