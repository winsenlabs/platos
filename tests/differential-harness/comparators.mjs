// WIN-284 — one comparator per acceptance dimension.
//
// Each comparator takes two NORMALISED observations and returns a list of
// divergences. A comparator never throws on a difference: a difference is data,
// and the twin-run decides what to do with it. It throws only when it is handed
// something it cannot compare at all, because silently returning [] for an
// input it did not understand is how a comparator reports parity over nothing.
//
// Every divergence carries a stable `code`. Codes are what the negative-control
// suite asserts on: it is not enough that a seeded difference produces "some"
// divergence, it must produce the RIGHT one. A harness that answers
// "something changed" to every seed has not shown it can localise drift.

import { DIMENSIONS } from "./observation.mjs";

export const DIVERGENCE_CODES = Object.freeze([
  "status-changed",
  "schema-field-missing",
  "schema-field-added",
  "schema-type-changed",
  "schema-value-changed",
  "header-missing",
  "header-added",
  "header-value-changed",
  "event-missing",
  "event-added",
  "event-reordered",
  "event-payload-changed",
  "auth-principal-changed",
  "auth-scope-missing",
  "auth-scope-added",
  "auth-decision-changed",
  "auth-reason-changed",
  "side-effect-missing",
  "side-effect-extra",
  "usage-changed",
  "cost-changed",
  "usage-measurement-changed",
  "store-table-missing",
  "store-table-added",
  "store-row-missing",
  "store-row-extra",
]);

// Code combinations that ONE real difference produces together, declared here
// beside the comparators that emit them.
//
// Why this list exists. `assertSeedCoverage` requires an ISOLATING seed for
// every code above — a seed that produces that code and nothing else — which
// makes each comparator branch individually provable. But some real differences
// are irreducibly joint: the pair IS the signature, and a catalogue that only
// isolated the parts would never have watched the pair go red. Declaring them
// makes those seeds required rather than optional, which is what stops the
// catalogue being silently truncated by one.
//
// A pair belongs here only when a single difference cannot produce one code
// without the other. Adding an entry adds a required seed; it never removes one,
// EXCEPT for the codes an entry lists in `absorbs` — codes this comparator can
// never emit alone, so demanding an isolating seed for them would demand a seed
// that cannot exist. `absorbs` is deliberately narrow and each use states the
// mechanism, because "it cannot be isolated" is the sentence an unfalsifiable
// gate hides behind.
export const JOINT_DIVERGENCES = Object.freeze([
  Object.freeze({
    id: "retype-is-also-a-value-change",
    codes: Object.freeze(["schema-type-changed", "schema-value-changed"]),
    absorbs: Object.freeze(["schema-type-changed"]),
    describes:
      "A leaf that changes type necessarily changes its serialised value too — `3` and `\"3\"` cannot be equal " +
      "under JSON comparison — so compareSchema physically cannot emit schema-type-changed on its own. The pair " +
      "is the only signature a retype can have, and it is the seed that proves the type branch fires.",
  }),
  Object.freeze({
    id: "authorisation-flip-with-reason",
    codes: Object.freeze(["auth-decision-changed", "auth-reason-changed"]),
    absorbs: Object.freeze([]),
    describes:
      "A real denial changes the decision AND states why. The decision alone is the artificial isolation " +
      "case; this pair is what an actual authorisation regression looks like.",
  }),
  Object.freeze({
    id: "in-place-row-change",
    codes: Object.freeze(["store-row-missing", "store-row-extra"]),
    absorbs: Object.freeze([]),
    describes:
      "Row identity is a multiset, so an in-place column change surfaces as the oracle row missing and the " +
      "candidate row extra. Either code alone means something else happened; the pair is the signature.",
  }),
]);

export function absorbedCodes(joints = JOINT_DIVERGENCES) {
  return new Set(joints.flatMap((joint) => [...(joint.absorbs ?? [])]));
}

// The exact expected-code signatures the seed catalogue must contain: one
// isolating signature per emittable code that CAN be emitted alone, plus every
// declared joint signature. Derived from the comparators, never hand-listed, so
// a new comparator branch creates a new obligation the moment its code is
// declared — and a seed cannot be deleted without one of these going unheld.
export function requiredSeedSignatures(joints = JOINT_DIVERGENCES, codes = DIVERGENCE_CODES) {
  const absorbed = absorbedCodes(joints);
  const signatures = new Map();
  for (const code of codes) {
    if (absorbed.has(code)) continue;
    signatures.set(code, { codes: [code], kind: "isolating", describes: `${code} emitted alone` });
  }
  for (const joint of joints) {
    signatures.set([...joint.codes].sort().join("+"), {
      codes: [...joint.codes].sort(),
      kind: "joint",
      describes: joint.describes,
    });
  }
  return signatures;
}

export function assertJointDivergencesAreWellFormed(joints = JOINT_DIVERGENCES) {
  const failures = [];
  const seen = new Set();
  const signatures = new Set();
  for (const joint of joints) {
    if (seen.has(joint.id)) failures.push(`joint divergence ${joint.id} is declared twice`);
    seen.add(joint.id);
    if (!Array.isArray(joint.codes) || joint.codes.length < 2) {
      failures.push(`joint divergence ${joint.id} must name at least two codes; one code is an isolating seed`);
      continue;
    }
    const signature = [...joint.codes].sort().join("+");
    if (signatures.has(signature)) failures.push(`joint divergence ${joint.id} repeats the signature ${signature}`);
    signatures.add(signature);
    for (const code of joint.codes) {
      if (!DIVERGENCE_CODES.includes(code)) failures.push(`joint divergence ${joint.id} names unknown code ${code}`);
    }
    for (const code of joint.absorbs ?? []) {
      if (!joint.codes.includes(code)) {
        failures.push(`joint divergence ${joint.id} absorbs ${code}, which it does not name`);
      }
    }
    if (typeof joint.describes !== "string" || joint.describes.trim().length < 30) {
      failures.push(`joint divergence ${joint.id} must say in prose why the codes are inseparable`);
    }
  }
  // An absorbed code has no isolating seed by construction, so the joint that
  // absorbs it is the ONLY proof that its branch can fire. Two joints absorbing
  // the same code would each look sufficient and neither would be required.
  const absorbedTwice = joints
    .flatMap((joint) => [...(joint.absorbs ?? [])])
    .filter((code, index, all) => all.indexOf(code) !== index);
  for (const code of new Set(absorbedTwice)) {
    failures.push(`code ${code} is absorbed by more than one joint divergence; its proof would be deletable`);
  }
  return failures;
}

// A tolerance is a normaliser wearing a different hat, and carries the same
// risk: widen it enough and the dimension stops measuring. So the ceiling is
// declared here rather than left to each scenario, and `assertTolerance`
// refuses anything above it. 1% on cost is enough to absorb integer rounding
// between two independent accumulators and far too tight to hide a pricing or
// unit-accounting change.
export const MAX_RELATIVE_TOLERANCE = 0.01;
export const DEFAULT_TOLERANCE = Object.freeze({ costMicros: 0, inputUnits: 0, outputUnits: 0 });

export function assertTolerance(tolerance = {}) {
  for (const [field, value] of Object.entries(tolerance)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`tolerance.${field} must be a non-negative finite number`);
    }
    if (value > MAX_RELATIVE_TOLERANCE) {
      throw new Error(
        `tolerance.${field}=${value} exceeds the ${MAX_RELATIVE_TOLERANCE} ceiling; a tolerance that wide stops the usage dimension measuring`,
      );
    }
  }
  return { ...DEFAULT_TOLERANCE, ...tolerance };
}

function divergence(dimension, code, path, oracle, candidate, message) {
  return { dimension, code, path, oracle, candidate, message };
}

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// A schema signature is the set of leaf POSITIONS and their types, with values
// discarded. Array positions are indexed, so a dropped element changes the
// signature rather than shifting every later element into a false mismatch.
export function schemaSignature(value, prefix = "$") {
  if (value === null || typeof value !== "object") return new Map([[prefix, typeName(value)]]);
  const signature = new Map();
  if (Array.isArray(value)) {
    if (value.length === 0) signature.set(prefix, "array:empty");
    else for (const [index, entry] of value.entries()) {
      for (const [path, type] of schemaSignature(entry, `${prefix}[${index}]`)) signature.set(path, type);
    }
    return signature;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) signature.set(prefix, "object:empty");
  else for (const [field, entry] of entries) {
    for (const [path, type] of schemaSignature(entry, `${prefix}.${field}`)) signature.set(path, type);
  }
  return signature;
}

export function compareStatus(oracle, candidate) {
  if (oracle.response.status === candidate.response.status) return [];
  return [
    divergence(
      "status",
      "status-changed",
      "response.status",
      oracle.response.status,
      candidate.response.status,
      `status ${oracle.response.status} became ${candidate.response.status}`,
    ),
  ];
}

// Headers that can never be declared volatile. Each one changes what a client
// does, so "it always varies" is never a reason to stop comparing it. Without
// this list a scenario could silence `www-authenticate` and hide exactly the
// auth regression this harness exists to find.
export const CONTRACT_HEADERS = Object.freeze([
  "content-type",
  "content-encoding",
  "location",
  "www-authenticate",
  "set-cookie",
  "cache-control",
  "retry-after",
  "allow",
]);

export function assertVolatileHeaders(volatileHeaders = []) {
  for (const header of volatileHeaders) {
    const name = String(header).toLowerCase();
    if (CONTRACT_HEADERS.includes(name)) {
      throw new Error(
        `${name} cannot be declared volatile: it changes client behaviour, so suppressing it would hide a real contract change`,
      );
    }
  }
  return new Set(volatileHeaders.map((header) => String(header).toLowerCase()));
}

function lowercaseKeys(headers) {
  return new Map(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
}

// `schema` in this harness means the whole response payload contract, not the
// body's shape alone: structure, VALUES, and headers.
//
// Shape-only comparison is the tempting reading of the word and it is the wrong
// one. A field that keeps its name and type but returns a different value is
// the most common regression a decomposition produces, and a harness blind to
// it would report parity on a body that is simply wrong. Values are compared
// AFTER normalisation, so identifiers and instants are already tokens by the
// time they get here and only real value drift survives.
export function compareSchema(oracle, candidate, options = {}) {
  const left = schemaSignature(oracle.response.body, "$");
  const right = schemaSignature(candidate.response.body, "$");
  const divergences = [];
  for (const [path, type] of left) {
    if (!right.has(path)) {
      divergences.push(
        divergence("schema", "schema-field-missing", path, type, null, `${path} is absent from the candidate`),
      );
    } else if (right.get(path) !== type) {
      divergences.push(
        divergence("schema", "schema-type-changed", path, type, right.get(path), `${path} changed type`),
      );
    }
  }
  for (const [path, type] of right) {
    if (!left.has(path)) {
      divergences.push(
        divergence("schema", "schema-field-added", path, null, type, `${path} is present only in the candidate`),
      );
    }
  }

  const candidateLeaves = leafValues(candidate.response.body, "$");
  for (const [path, value] of leafValues(oracle.response.body, "$")) {
    if (!candidateLeaves.has(path)) continue;
    const other = candidateLeaves.get(path);
    if (JSON.stringify(other) !== JSON.stringify(value)) {
      divergences.push(
        divergence("schema", "schema-value-changed", path, value, other, `${path} changed value`),
      );
    }
  }

  const volatile = assertVolatileHeaders(options.volatileHeaders);
  const oracleHeaders = lowercaseKeys(oracle.response.headers);
  const candidateHeaders = lowercaseKeys(candidate.response.headers);
  for (const [name, value] of oracleHeaders) {
    if (volatile.has(name)) continue;
    if (!candidateHeaders.has(name)) {
      divergences.push(
        divergence("schema", "header-missing", `headers.${name}`, value, null, `header ${name} is absent from the candidate`),
      );
    } else if (candidateHeaders.get(name) !== value) {
      divergences.push(
        divergence("schema", "header-value-changed", `headers.${name}`, value, candidateHeaders.get(name),
          `header ${name} changed value`),
      );
    }
  }
  for (const [name, value] of candidateHeaders) {
    if (volatile.has(name)) continue;
    if (!oracleHeaders.has(name)) {
      divergences.push(
        divergence("schema", "header-added", `headers.${name}`, null, value, `header ${name} is present only in the candidate`),
      );
    }
  }
  return divergences;
}

// Leaf POSITION to leaf VALUE, using the same path grammar as schemaSignature
// so a structural finding and a value finding on the same field report the
// same path and a reader can line them up.
export function leafValues(value, prefix = "$", into = new Map()) {
  if (value === null || typeof value !== "object") {
    into.set(prefix, value);
    return into;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) into.set(prefix, []);
    else for (const [index, entry] of value.entries()) leafValues(entry, `${prefix}[${index}]`, into);
    return into;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) into.set(prefix, {});
  else for (const [field, entry] of entries) leafValues(entry, `${prefix}.${field}`, into);
  return into;
}

function eventKey(event) {
  return `${event.name} ${JSON.stringify([...schemaSignature(event.payload, "payload")].sort())}`;
}

function multiset(keys) {
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

// Order is compared BEFORE membership, and reported separately. Collapsing the
// two would let a reordering be reported as "one event missing, one added",
// which reads as two unrelated defects instead of the ordering change it is.
export function compareEvents(oracle, candidate) {
  const left = oracle.events.map(eventKey);
  const right = candidate.events.map(eventKey);
  const leftCounts = multiset(left);
  const rightCounts = multiset(right);
  const divergences = [];

  for (const [key, count] of leftCounts) {
    const present = rightCounts.get(key) ?? 0;
    for (let index = present; index < count; index += 1) {
      divergences.push(
        divergence("events", "event-missing", `events[${left.indexOf(key)}]`, key.split(" ")[0], null,
          `event ${key.split(" ")[0]} is absent from the candidate`),
      );
    }
  }
  for (const [key, count] of rightCounts) {
    const present = leftCounts.get(key) ?? 0;
    for (let index = present; index < count; index += 1) {
      divergences.push(
        divergence("events", "event-added", `events[${right.indexOf(key)}]`, null, key.split(" ")[0],
          `event ${key.split(" ")[0]} is present only in the candidate`),
      );
    }
  }

  // Same membership, different sequence: a pure reordering.
  if (divergences.length === 0) {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        divergences.push(
          divergence("events", "event-reordered", `events[${index}]`,
            oracle.events[index].name, candidate.events[index].name,
            `event order changed at position ${index}`),
        );
        break;
      }
    }
  }

  // Same name and same position, different payload SHAPE is caught by the key.
  // Same name, same position, same shape, different VALUE is a payload change.
  if (divergences.length === 0) {
    for (let index = 0; index < oracle.events.length; index += 1) {
      const oraclePayload = JSON.stringify(oracle.events[index].payload);
      const candidatePayload = JSON.stringify(candidate.events[index].payload);
      if (oraclePayload !== candidatePayload) {
        divergences.push(
          divergence("events", "event-payload-changed", `events[${index}].payload`,
            oracle.events[index].payload, candidate.events[index].payload,
            `payload of ${oracle.events[index].name} changed`),
        );
      }
    }
  }
  return divergences;
}

export function compareAuth(oracle, candidate) {
  const divergences = [];
  if (oracle.auth.principal !== candidate.auth.principal) {
    divergences.push(
      divergence("auth", "auth-principal-changed", "auth.principal", oracle.auth.principal,
        candidate.auth.principal, "the resolved principal changed"),
    );
  }
  if (oracle.auth.decision !== candidate.auth.decision) {
    divergences.push(
      divergence("auth", "auth-decision-changed", "auth.decision", oracle.auth.decision,
        candidate.auth.decision, `authorisation decision ${oracle.auth.decision} became ${candidate.auth.decision}`),
    );
  }
  const left = new Set(oracle.auth.scopes);
  const right = new Set(candidate.auth.scopes);
  for (const scope of left) {
    if (!right.has(scope)) {
      divergences.push(
        divergence("auth", "auth-scope-missing", "auth.scopes", scope, null, `scope ${scope} is not granted on the candidate`),
      );
    }
  }
  for (const scope of right) {
    if (!left.has(scope)) {
      divergences.push(
        divergence("auth", "auth-scope-added", "auth.scopes", null, scope, `scope ${scope} is granted only on the candidate`),
      );
    }
  }
  if (oracle.auth.reason !== candidate.auth.reason) {
    divergences.push(
      divergence("auth", "auth-reason-changed", "auth.reason", oracle.auth.reason, candidate.auth.reason,
        "the denial or grant reason changed"),
    );
  }
  return divergences;
}

function sideEffectKey(effect) {
  return `${effect.kind} ${effect.target} ${JSON.stringify(effect.detail)}`;
}

// Side effects are compared as a MULTISET, not a sequence: two stores may flush
// two independent writes in either order and that is not drift. Ordering
// between side effects that genuinely must be sequenced is expressed as events,
// which are order-significant.
export function compareSideEffects(oracle, candidate) {
  const leftCounts = multiset(oracle.sideEffects.map(sideEffectKey));
  const rightCounts = multiset(candidate.sideEffects.map(sideEffectKey));
  const divergences = [];
  for (const [key, count] of leftCounts) {
    const present = rightCounts.get(key) ?? 0;
    for (let index = present; index < count; index += 1) {
      const [kind, target] = key.split(" ");
      divergences.push(
        divergence("sideEffects", "side-effect-missing", `${kind} ${target}`, key, null,
          `side effect ${kind} on ${target} did not happen on the candidate`),
      );
    }
  }
  for (const [key, count] of rightCounts) {
    const present = leftCounts.get(key) ?? 0;
    for (let index = present; index < count; index += 1) {
      const [kind, target] = key.split(" ");
      divergences.push(
        divergence("sideEffects", "side-effect-extra", `${kind} ${target}`, null, key,
          `side effect ${kind} on ${target} happened only on the candidate`),
      );
    }
  }
  return divergences;
}

// Compares only the components BOTH sides declare they meter. A side that
// silently stops metering something is not agreement, it is a change in what is
// being measured, and it gets its own code so the report says so rather than
// reporting "0 == 0" as parity.
export function compareUsage(oracle, candidate, options = {}) {
  const tolerance = assertTolerance(options.tolerance);
  const divergences = [];
  const left = [...(oracle.usage.measured ?? [])].sort();
  const right = [...(candidate.usage.measured ?? [])].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    divergences.push(
      divergence("usage", "usage-measurement-changed", "usage.measured", left, right,
        `the metered components changed from [${left.join(", ")}] to [${right.join(", ")}]`),
    );
  }
  for (const field of left.filter((component) => right.includes(component))) {
    const oracleValue = oracle.usage[field];
    const candidateValue = candidate.usage[field];
    const allowed = Math.abs(oracleValue) * (tolerance[field] ?? 0);
    if (Math.abs(oracleValue - candidateValue) > allowed) {
      divergences.push(
        divergence("usage", field === "costMicros" ? "cost-changed" : "usage-changed", `usage.${field}`,
          oracleValue, candidateValue, `usage.${field} moved from ${oracleValue} to ${candidateValue}`),
      );
    }
  }
  return divergences;
}

function rowKey(row) {
  return JSON.stringify(Object.entries(row).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

export function compareStore(oracle, candidate) {
  const divergences = [];
  const tables = new Set([...Object.keys(oracle.store), ...Object.keys(candidate.store)]);
  for (const table of [...tables].sort()) {
    const left = oracle.store[table];
    const right = candidate.store[table];
    if (left !== undefined && right === undefined) {
      divergences.push(divergence("store", "store-table-missing", table, `${left.length} rows`, null,
        `table ${table} is absent from the candidate store`));
      continue;
    }
    if (left === undefined && right !== undefined) {
      divergences.push(divergence("store", "store-table-added", table, null, `${right.length} rows`,
        `table ${table} is present only in the candidate store`));
      continue;
    }
    const leftCounts = multiset(left.map(rowKey));
    const rightCounts = multiset(right.map(rowKey));
    for (const [key, count] of leftCounts) {
      const present = rightCounts.get(key) ?? 0;
      for (let index = present; index < count; index += 1) {
        divergences.push(divergence("store", "store-row-missing", table, JSON.parse(key), null,
          `a row in ${table} is absent from the candidate store`));
      }
    }
    for (const [key, count] of rightCounts) {
      const present = leftCounts.get(key) ?? 0;
      for (let index = present; index < count; index += 1) {
        divergences.push(divergence("store", "store-row-extra", table, null, JSON.parse(key),
          `a row in ${table} exists only in the candidate store`));
      }
    }
  }
  return divergences;
}

export const COMPARATORS = Object.freeze({
  status: compareStatus,
  schema: compareSchema,
  events: compareEvents,
  auth: compareAuth,
  sideEffects: compareSideEffects,
  usage: compareUsage,
  store: compareStore,
});

// Every acceptance dimension must have a comparator, and every comparator must
// name an acceptance dimension. Checked rather than assumed so a dimension can
// never be added to the contract and left unimplemented while the matrix still
// counts it as compared.
//
// The two arguments exist so this function can be controlled on its own.
// Neutering it in place leaves both gates green, because `validateScenario`
// independently refuses a dimension with no comparator — a redundancy, not a
// hole, but a redundancy that hid whether THIS function still worked. Passing
// it a deliberately broken registry isolates it from that second guard.
export function assertComparatorCoverage(comparators = COMPARATORS, dimensions = DIMENSIONS) {
  const failures = [];
  for (const dimension of dimensions) {
    if (typeof comparators[dimension] !== "function") failures.push(`dimension ${dimension} has no comparator`);
  }
  for (const dimension of Object.keys(comparators)) {
    if (!dimensions.includes(dimension)) failures.push(`comparator ${dimension} is not an acceptance dimension`);
  }
  return failures;
}
