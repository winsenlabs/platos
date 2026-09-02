// WIN-284 — the normalisation register must be sensitive, and must be PROVEN
// sensitive rather than declared sensitive.
//
// Every assertion here has a mutation twin: it is not enough that the register
// passes its own guard, the guard must be shown to reject a register that
// should fail. A guard nobody has watched go red is not a guard.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NORMALISERS,
  ORDER_LOCKED_COLLECTIONS,
  assertRegisterIsSensitive,
  normalise,
  normaliserById,
  sortDeclaredUnordered,
} from "./normalisers.mjs";
import { baselineObservation } from "./seeds.mjs";
import { twinRun } from "./twin-run.mjs";

test("every registered normaliser erases its declared nondeterminism and nothing more", () => {
  assert.deepEqual(assertRegisterIsSensitive(), []);
});

test("the register is non-empty and every entry documents what it erases and preserves", () => {
  assert.ok(NORMALISERS.length >= 5, "a register this small would not cover twin-store nondeterminism");
  for (const normaliser of NORMALISERS) {
    assert.ok(normaliser.erases.length >= 40, `${normaliser.id} must document what it erases`);
    assert.ok(normaliser.preserves.length >= 40, `${normaliser.id} must document what it preserves`);
    assert.ok(normaliser.dimensions.length > 0, `${normaliser.id} must name the dimensions it applies to`);
  }
});

// ---------------------------------------------------------------------------
// MUTATION CONTROLS — the guard must reject registers that should fail
// ---------------------------------------------------------------------------

test("MUTATION: an over-broad normaliser is rejected", () => {
  // The classic vacuous normaliser: erase everything, and every comparison
  // passes forever. Its "equivalent" fixture succeeds; its "divergent" fixture
  // is what exposes it.
  const overBroad = [
    {
      id: "erase-everything",
      dimensions: ["schema"],
      erases: "Every string value anywhere in the observation, which is far more than any nondeterminism.",
      preserves: "Nothing at all, which is exactly the problem this control exists to surface.",
      apply: (value) => JSON.parse(JSON.stringify(value, (_key, entry) => (typeof entry === "string" ? "<any>" : entry))),
      sensitivity: {
        equivalent: [{ a: "one" }, { a: "two" }],
        divergent: [{ a: "real" }, { a: "different" }],
      },
    },
  ];
  const failures = assertRegisterIsSensitive(overBroad);
  assert.ok(
    failures.some((failure) => failure.includes("OVER-BROAD")),
    `expected an over-broad rejection, saw ${JSON.stringify(failures)}`,
  );
});

test("MUTATION: a normaliser with no sensitivity pair is rejected", () => {
  const undocumented = [
    {
      id: "no-evidence",
      dimensions: ["schema"],
      erases: "Something unspecified that nobody has ever demonstrated on a concrete pair of inputs.",
      preserves: "Something unspecified that nobody has ever demonstrated on a concrete pair of inputs.",
      apply: (value) => value,
    },
  ];
  const failures = assertRegisterIsSensitive(undocumented);
  assert.ok(failures.some((failure) => failure.includes("no sensitivity pair")));
});

test("MUTATION: a normaliser that fails to erase its own nondeterminism is rejected", () => {
  const inert = [
    {
      id: "does-nothing",
      dimensions: ["schema"],
      erases: "Claims to erase instants but the implementation is the identity function, so it erases nothing.",
      preserves: "Claims to preserve ordering, which is trivially true of a function that changes nothing.",
      apply: (value) => value,
      sensitivity: {
        equivalent: [{ at: "2026-09-02T10:00:00.000Z" }, { at: "2026-09-02T11:00:00.000Z" }],
        divergent: [{ at: "2026-09-02T10:00:00.000Z" }, { at: "2026-09-02T10:00:01.000Z" }],
      },
    },
  ];
  const failures = assertRegisterIsSensitive(inert);
  assert.ok(failures.some((failure) => failure.includes("failed to erase")));
});

test("MUTATION: an identical sensitivity pair proves nothing and is rejected", () => {
  const lazy = [
    {
      id: "identical-fixtures",
      dimensions: ["schema"],
      erases: "Claims to erase instants, demonstrated on two inputs that are byte-identical to each other.",
      preserves: "Claims to preserve ordering, demonstrated on two inputs that are byte-identical to each other.",
      apply: (value) => value,
      sensitivity: {
        equivalent: [{ at: "2026-09-02T10:00:00.000Z" }, { at: "2026-09-02T10:00:00.000Z" }],
        divergent: [{ at: "2026-09-02T10:00:00.000Z" }, { at: "2026-09-02T10:00:00.000Z" }],
      },
    },
  ];
  const failures = assertRegisterIsSensitive(lazy);
  assert.ok(failures.some((failure) => failure.includes("identical inputs")));
});

// ---------------------------------------------------------------------------
// Order lock
// ---------------------------------------------------------------------------

test("events can never be declared unordered", () => {
  assert.ok(ORDER_LOCKED_COLLECTIONS.includes("events"));
  assert.throws(
    () => sortDeclaredUnordered(baselineObservation("oracle"), ["events"]),
    /cannot be declared unordered/u,
  );
});

test("a declared-unordered collection is sorted, and an undeclared one is left alone", () => {
  const observation = { sideEffects: [{ z: 1 }, { a: 2 }], other: [{ z: 1 }, { a: 2 }] };
  const sorted = sortDeclaredUnordered(observation, ["sideEffects"]);
  assert.deepEqual(sorted.sideEffects, [{ a: 2 }, { z: 1 }]);
  assert.deepEqual(sorted.other, [{ z: 1 }, { a: 2 }]);
});

// ---------------------------------------------------------------------------
// The clean run's parity must be EARNED
// ---------------------------------------------------------------------------

test("NON-VACUITY: without the register the clean twin pair diverges", async () => {
  // If the two clean fixtures compared equal with normalisation switched off,
  // the clean control would be proving nothing — the fixtures would simply be
  // the same. They are not: they differ in identifiers, clocks, durations and
  // sequence starts, and the register is what makes them comparable.
  const scenario = {
    id: "earned-parity",
    dimensions: ["status", "schema", "events", "auth", "sideEffects", "usage", "store"],
  };
  const subject = (side) => ({ async run(target) { return { ...baselineObservation(side), scenario: target.id }; } });

  const withoutRegister = await twinRun(scenario, { oracle: subject("oracle"), candidate: subject("candidate") }, {
    skipNormalisers: NORMALISERS.map((normaliser) => normaliser.id),
  });
  assert.equal(withoutRegister.verdict, "divergent");
  assert.ok(withoutRegister.divergences.length > 0);

  const withRegister = await twinRun(scenario, { oracle: subject("oracle"), candidate: subject("candidate") });
  assert.equal(withRegister.verdict, "parity");
});

test("normaliserById refuses an unknown id rather than silently doing nothing", () => {
  assert.throws(() => normaliserById("not-a-normaliser"), /unknown normaliser/u);
});

test("instant-rank preserves relative order across sides", () => {
  const left = normalise({ events: [{ at: "2026-01-01T00:00:00Z" }, { at: "2026-01-01T00:00:10Z" }] });
  const right = normalise({ events: [{ at: "2026-06-01T09:00:00Z" }, { at: "2026-06-01T09:00:30Z" }] });
  assert.deepEqual(left, right, "two ascending pairs normalise to the same ranks");

  const flipped = normalise({ events: [{ at: "2026-06-01T09:00:30Z" }, { at: "2026-06-01T09:00:00Z" }] });
  assert.notDeepEqual(left, flipped, "a descending pair must not normalise to an ascending one");
});
