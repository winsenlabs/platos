// WIN-284 — the seeded-divergence catalogue. These are the negative controls.
//
// A parity harness that has never been shown to catch a deliberate difference
// is decoration. Everything else in this directory is machinery; this file is
// the evidence that the machinery works.
//
// Each seed takes the candidate observation and introduces ONE real difference
// of a named class, then declares which divergence codes the harness must
// produce. Two properties make the control meaningful rather than ceremonial:
//
//   1. The seed is applied to a twin-run that, UNSEEDED, reports parity. A
//      harness that is simply always-red would pass every negative control and
//      be worthless. The runner asserts the clean run first, every time.
//   2. The seed must produce the RIGHT code, not merely "a divergence". A
//      harness that answers "something changed" to every input has not shown it
//      can localise drift, and a report like that is unusable at M3.1 scale.
//
// `assertSeedCoverage` requires every divergence code the comparators can emit
// to have at least one seed. A comparator branch with no seed behind it is a
// branch nobody has ever seen go red.

import { DIVERGENCE_CODES } from "./comparators.mjs";
import { DIMENSIONS } from "./observation.mjs";

// The baseline both sides return when nothing is seeded. Deliberately rich
// enough that every dimension carries several comparable facts, so a seed that
// removes one thing still leaves the dimension non-vacuous and the run reaches
// the comparator instead of stopping at the vacuity guard.
export function baselineObservation(side, overrides = {}) {
  return {
    scenario: "harness-self-test",
    side,
    subject: `recorded:${side}`,
    storeIdentity: side === "oracle" ? "store-oracle" : "store-candidate",
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        id: side === "oracle"
          ? "0b8f2a4c-1d3e-4f5a-8b9c-0d1e2f3a4b5c"
          : "7c9e1b2d-3f4a-4b6c-9d8e-1a2b3c4d5e6f",
        name: "conservation-fixture",
        revision: 3,
        labels: ["alpha", "beta"],
        nested: { enabled: true, threshold: 12 },
      },
    },
    events: [
      { name: "record.opened", payload: { at: side === "oracle" ? "2026-09-02T10:00:00.000Z" : "2026-09-02T10:04:00.000Z", phase: "open" } },
      { name: "record.written", payload: { at: side === "oracle" ? "2026-09-02T10:00:01.000Z" : "2026-09-02T10:04:01.000Z", bytes: 512 } },
      { name: "record.closed", payload: { at: side === "oracle" ? "2026-09-02T10:00:02.000Z" : "2026-09-02T10:04:02.000Z", phase: "closed" } },
    ],
    auth: {
      principal: "operator:alpha",
      scopes: ["records.read", "records.write"],
      decision: "allow",
      reason: null,
    },
    sideEffects: [
      { kind: "insert", target: "record", detail: { rows: 1 } },
      { kind: "notify", target: "outbox", detail: { channel: "records" } },
    ],
    usage: {
      measured: ["inputUnits", "outputUnits", "costMicros"],
      inputUnits: 120,
      outputUnits: 45,
      costMicros: 900,
      durationMs: side === "oracle" ? 31 : 47,
    },
    store: {
      record: [
        { id: side === "oracle" ? 1 : 41, name: "conservation-fixture", revision: 3 },
        { id: side === "oracle" ? 2 : 42, name: "sibling", revision: 1 },
      ],
      outbox: [{ id: side === "oracle" ? 1 : 91, channel: "records", delivered: false }],
    },
    ...overrides,
  };
}

function clone(observation) {
  return JSON.parse(JSON.stringify(observation));
}

function withBody(observation, edit) {
  const next = clone(observation);
  edit(next.response.body);
  return next;
}

export const SEEDS = Object.freeze([
  Object.freeze({
    id: "status-code-changed",
    dimension: "status",
    describes: "The candidate answers 201 where the oracle answered 200 — the classic silent contract break.",
    expectedCodes: Object.freeze(["status-changed"]),
    seed: (observation) => {
      const next = clone(observation);
      next.response.status = 201;
      return next;
    },
  }),
  Object.freeze({
    id: "response-field-dropped",
    dimension: "schema",
    describes: "A response field the oracle returns is absent from the candidate body.",
    expectedCodes: Object.freeze(["schema-field-missing"]),
    seed: (observation) => withBody(observation, (body) => { delete body.revision; }),
  }),
  Object.freeze({
    id: "response-field-added",
    dimension: "schema",
    describes: "The candidate returns a field the oracle never returned. Additive drift is still drift; a client that pins its schema breaks on it.",
    expectedCodes: Object.freeze(["schema-field-added"]),
    seed: (observation) => withBody(observation, (body) => { body.introducedField = "unexpected"; }),
  }),
  Object.freeze({
    id: "response-field-retyped",
    dimension: "schema",
    describes: "A field keeps its name and position but changes type — number becomes string.",
    expectedCodes: Object.freeze(["schema-type-changed"]),
    seed: (observation) => withBody(observation, (body) => { body.revision = "3"; }),
  }),
  Object.freeze({
    id: "response-value-changed",
    dimension: "schema",
    describes: "A field keeps its name, position and type and returns a different value. Shape-only comparison misses this entirely, and it is the most common regression a decomposition actually produces.",
    expectedCodes: Object.freeze(["schema-value-changed"]),
    seed: (observation) => withBody(observation, (body) => { body.nested.threshold = 13; }),
  }),
  Object.freeze({
    id: "response-header-dropped",
    dimension: "schema",
    describes: "A response header the oracle sent is absent from the candidate. Headers are contract; a missing content-type changes how every client parses the body.",
    expectedCodes: Object.freeze(["header-missing"]),
    seed: (observation) => {
      const next = clone(observation);
      delete next.response.headers["content-type"];
      return next;
    },
  }),
  Object.freeze({
    id: "response-header-added",
    dimension: "schema",
    describes: "The candidate sends a header the oracle never sent.",
    expectedCodes: Object.freeze(["header-added"]),
    seed: (observation) => {
      const next = clone(observation);
      next.response.headers["x-introduced"] = "1";
      return next;
    },
  }),
  Object.freeze({
    id: "response-header-value-changed",
    dimension: "schema",
    describes: "A header keeps its name and changes value — the charset drops off content-type, or a cache directive flips.",
    expectedCodes: Object.freeze(["header-value-changed"]),
    seed: (observation) => {
      const next = clone(observation);
      next.response.headers["content-type"] = "text/plain";
      return next;
    },
  }),
  Object.freeze({
    id: "event-dropped",
    dimension: "events",
    describes: "One event in the ordered log never fires on the candidate.",
    expectedCodes: Object.freeze(["event-missing"]),
    seed: (observation) => {
      const next = clone(observation);
      next.events.splice(1, 1);
      return next;
    },
  }),
  Object.freeze({
    id: "event-added",
    dimension: "events",
    describes: "The candidate emits an event the oracle never emitted.",
    expectedCodes: Object.freeze(["event-added"]),
    seed: (observation) => {
      const next = clone(observation);
      next.events.push({ name: "record.reindexed", payload: { at: "2026-09-02T10:04:03.000Z", phase: "extra" } });
      return next;
    },
  }),
  Object.freeze({
    id: "event-reordered",
    dimension: "events",
    describes: "The same events in a different sequence. This is the seed an order-normalising harness silently loses, which is why `events` is refused by sortDeclaredUnordered.",
    expectedCodes: Object.freeze(["event-reordered"]),
    seed: (observation) => {
      const next = clone(observation);
      const [first, second] = [next.events[0], next.events[1]];
      // Swap the names but leave the instants ascending in place. Without this
      // the instants would also swap, and instant-rank would report the
      // ordering change through the payload instead — which would still be
      // caught, but by the wrong code, and the control would not be testing
      // what it claims to test.
      const firstAt = first.payload.at;
      const secondAt = second.payload.at;
      next.events[0] = { ...second, payload: { ...second.payload, at: firstAt } };
      next.events[1] = { ...first, payload: { ...first.payload, at: secondAt } };
      return next;
    },
  }),
  Object.freeze({
    id: "event-payload-changed",
    dimension: "events",
    describes: "Same events, same order, one payload value differs.",
    expectedCodes: Object.freeze(["event-payload-changed"]),
    seed: (observation) => {
      const next = clone(observation);
      next.events[1].payload.bytes = 1024;
      return next;
    },
  }),
  Object.freeze({
    id: "auth-principal-changed",
    dimension: "auth",
    describes: "The candidate resolves a different principal for the same credential.",
    expectedCodes: Object.freeze(["auth-principal-changed"]),
    seed: (observation) => {
      const next = clone(observation);
      next.auth.principal = "operator:beta";
      return next;
    },
  }),
  Object.freeze({
    id: "auth-scope-dropped",
    dimension: "auth",
    describes: "A scope the oracle granted is not granted on the candidate — a quiet permission regression.",
    expectedCodes: Object.freeze(["auth-scope-missing"]),
    seed: (observation) => {
      const next = clone(observation);
      next.auth.scopes = next.auth.scopes.filter((scope) => scope !== "records.write");
      return next;
    },
  }),
  Object.freeze({
    id: "auth-scope-widened",
    dimension: "auth",
    describes: "The candidate grants a scope the oracle did not. This is the dangerous direction: privilege that appears during a refactor and nobody asked for.",
    expectedCodes: Object.freeze(["auth-scope-added"]),
    seed: (observation) => {
      const next = clone(observation);
      next.auth.scopes = [...next.auth.scopes, "records.admin"];
      return next;
    },
  }),
  Object.freeze({
    id: "auth-decision-flipped",
    dimension: "auth",
    describes: "The oracle allowed the call and the candidate denies it, or the reverse.",
    expectedCodes: Object.freeze(["auth-decision-changed", "auth-reason-changed"]),
    seed: (observation) => {
      const next = clone(observation);
      next.auth.decision = "deny";
      next.auth.reason = "scope.missing";
      return next;
    },
  }),
  Object.freeze({
    id: "auth-reason-changed",
    dimension: "auth",
    describes: "Same decision, different stated reason. Clients branch on the reason code, so it is part of the contract.",
    expectedCodes: Object.freeze(["auth-reason-changed"]),
    seed: (observation) => {
      const next = clone(observation);
      next.auth.reason = "grant.inherited";
      return next;
    },
  }),
  Object.freeze({
    id: "side-effect-missing",
    dimension: "sideEffects",
    describes: "The candidate answers identically but never performs one of the writes. The response is a perfect match and the system is wrong.",
    expectedCodes: Object.freeze(["side-effect-missing"]),
    seed: (observation) => {
      const next = clone(observation);
      next.sideEffects = next.sideEffects.filter((effect) => effect.target !== "outbox");
      return next;
    },
  }),
  Object.freeze({
    id: "side-effect-extra",
    dimension: "sideEffects",
    describes: "The candidate performs a write the oracle never performed — a duplicated or newly introduced effect.",
    expectedCodes: Object.freeze(["side-effect-extra"]),
    seed: (observation) => {
      const next = clone(observation);
      next.sideEffects = [...next.sideEffects, { kind: "insert", target: "audit", detail: { rows: 1 } }];
      return next;
    },
  }),
  Object.freeze({
    id: "usage-units-changed",
    dimension: "usage",
    describes: "Token or unit accounting drifts. Metered surfaces bill on this, so a silent change is a billing change.",
    expectedCodes: Object.freeze(["usage-changed"]),
    seed: (observation) => {
      const next = clone(observation);
      next.usage.outputUnits = 60;
      return next;
    },
  }),
  Object.freeze({
    id: "cost-inflated",
    dimension: "usage",
    describes: "Cost moves by 5%, well beyond the 1% ceiling the tolerance is allowed to carry.",
    expectedCodes: Object.freeze(["cost-changed"]),
    seed: (observation) => {
      const next = clone(observation);
      next.usage.costMicros = Math.round(next.usage.costMicros * 1.05);
      return next;
    },
  }),
  Object.freeze({
    id: "usage-measurement-dropped",
    dimension: "usage",
    describes: "The candidate stops metering cost altogether. Both sides would then report zero and a naive comparator would call that agreement, when in fact one side stopped measuring.",
    expectedCodes: Object.freeze(["usage-measurement-changed"]),
    seed: (observation) => {
      const next = clone(observation);
      next.usage.measured = next.usage.measured.filter((component) => component !== "costMicros");
      next.usage.costMicros = 0;
      return next;
    },
  }),
  Object.freeze({
    id: "store-table-missing",
    dimension: "store",
    describes: "A whole table the oracle wrote is untouched on the candidate.",
    expectedCodes: Object.freeze(["store-table-missing"]),
    seed: (observation) => {
      const next = clone(observation);
      delete next.store.outbox;
      return next;
    },
  }),
  Object.freeze({
    id: "store-table-added",
    dimension: "store",
    describes: "The candidate writes a table the oracle never wrote.",
    expectedCodes: Object.freeze(["store-table-added"]),
    seed: (observation) => {
      const next = clone(observation);
      next.store.shadowIndex = [{ id: 1, name: "conservation-fixture" }];
      return next;
    },
  }),
  Object.freeze({
    id: "store-row-missing",
    dimension: "store",
    describes: "A row the oracle persisted is absent from the candidate store. State conservation broken.",
    expectedCodes: Object.freeze(["store-row-missing"]),
    seed: (observation) => {
      const next = clone(observation);
      next.store.record = next.store.record.slice(0, 1);
      return next;
    },
  }),
  Object.freeze({
    id: "store-row-extra",
    dimension: "store",
    describes: "The candidate persists a row the oracle did not.",
    expectedCodes: Object.freeze(["store-row-extra"]),
    seed: (observation) => {
      const next = clone(observation);
      next.store.record = [...next.store.record, { id: 43, name: "orphan", revision: 1 }];
      return next;
    },
  }),
  Object.freeze({
    id: "store-value-changed",
    dimension: "store",
    describes: "A persisted column value differs. Row identity is a multiset, so a changed value surfaces as the oracle row missing and the candidate row extra — the pair, not one alone, is the signature of an in-place change.",
    expectedCodes: Object.freeze(["store-row-missing", "store-row-extra"]),
    seed: (observation) => {
      const next = clone(observation);
      next.store.record[0].revision = 99;
      return next;
    },
  }),
]);

export function seedById(id) {
  const found = SEEDS.find((seed) => seed.id === id);
  if (!found) throw new Error(`unknown seed ${id}`);
  return found;
}

// Coverage of the catalogue over what the comparators can emit. A code with no
// seed is a comparator branch nobody has ever watched go red.
export function assertSeedCoverage(seeds = SEEDS) {
  const failures = [];
  const covered = new Set();
  const seenIds = new Set();
  for (const seed of seeds) {
    if (seenIds.has(seed.id)) failures.push(`seed ${seed.id} is declared twice`);
    seenIds.add(seed.id);
    if (!DIMENSIONS.includes(seed.dimension)) failures.push(`seed ${seed.id} names unknown dimension ${seed.dimension}`);
    if (typeof seed.describes !== "string" || seed.describes.trim().length < 30) {
      failures.push(`seed ${seed.id} must describe the difference it introduces, in prose`);
    }
    if (!Array.isArray(seed.expectedCodes) || seed.expectedCodes.length === 0) {
      failures.push(`seed ${seed.id} declares no expected divergence code`);
      continue;
    }
    for (const code of seed.expectedCodes) {
      if (!DIVERGENCE_CODES.includes(code)) failures.push(`seed ${seed.id} expects unknown code ${code}`);
      covered.add(code);
    }
  }
  for (const code of DIVERGENCE_CODES) {
    if (!covered.has(code)) failures.push(`divergence code ${code} has no seed; nothing proves that branch can fire`);
  }
  for (const dimension of DIMENSIONS) {
    if (!seeds.some((seed) => seed.dimension === dimension)) {
      failures.push(`dimension ${dimension} has no seeded divergence; it is compared but never proven sensitive`);
    }
  }
  return failures;
}
