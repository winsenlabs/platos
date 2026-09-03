// WIN-284 — the observation record: everything one side of a twin-run produces.
//
// An Observation is the ONLY thing the comparators ever see. Subjects differ
// wildly (a recorded bundle, a real isolated PostgreSQL store, later a live V1
// transport); they all reduce to this one shape, so a comparator can never
// accidentally depend on how a side was produced.
//
// The eight fields below are the eight things the issue's acceptance clause
// names: status, schema, events, auth, side effects, usage/cost, and store
// state. `response` carries both status and schema because they are two
// readings of one artifact, and separating them at capture time would let a
// subject report a status without a body and still look complete.
//
// FAIL-CLOSED CAPTURE. `validateObservation` rejects a malformed or absent
// field rather than defaulting it. A defaulted field is the exact mechanism by
// which a parity harness reports green over nothing: two sides that both
// produced no events "agree" on events, and the report reads as parity when it
// is really absence. Every default here would be a lie about what was measured,
// so there are none.

export const DIMENSIONS = Object.freeze([
  "status",
  "schema",
  "events",
  "auth",
  "sideEffects",
  "usage",
  "store",
]);

export const SIDES = Object.freeze(["oracle", "candidate"]);

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function requirePlainObject(value, label, errors) {
  if (typeName(value) !== "object") {
    errors.push(`${label} must be an object, saw ${typeName(value)}`);
    return false;
  }
  return true;
}

function requireArray(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array, saw ${typeName(value)}`);
    return false;
  }
  return true;
}

function requireFiniteNumber(value, label, errors) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${label} must be a finite number, saw ${typeName(value)}`);
    return false;
  }
  return true;
}

function requireNonEmptyString(value, label, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} must be a non-empty string`);
    return false;
  }
  return true;
}

function validateResponse(response, errors) {
  if (!requirePlainObject(response, "response", errors)) return;
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    errors.push("response.status must be an integer HTTP status in [100, 599]");
  }
  if (requirePlainObject(response.headers, "response.headers", errors)) {
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value !== "string") errors.push(`response.headers[${key}] must be a string`);
    }
  }
  if (!Object.hasOwn(response, "body")) {
    // Absent and null are different facts. A subject that produced no body must
    // say `body: null` explicitly so the schema comparator can compare "no
    // body" against "a body" instead of silently skipping the field.
    errors.push("response.body must be present (use null to state that no body was produced)");
  }
}

function validateEvents(events, errors) {
  if (!requireArray(events, "events", errors)) return;
  for (const [index, event] of events.entries()) {
    const label = `events[${index}]`;
    if (!requirePlainObject(event, label, errors)) continue;
    requireNonEmptyString(event.name, `${label}.name`, errors);
    if (!Object.hasOwn(event, "payload")) errors.push(`${label}.payload must be present`);
  }
}

function validateAuth(auth, errors) {
  if (!requirePlainObject(auth, "auth", errors)) return;
  if (auth.principal !== null && typeof auth.principal !== "string") {
    errors.push("auth.principal must be a string or null");
  }
  if (requireArray(auth.scopes, "auth.scopes", errors)) {
    for (const [index, scope] of auth.scopes.entries()) {
      requireNonEmptyString(scope, `auth.scopes[${index}]`, errors);
    }
  }
  if (auth.decision !== "allow" && auth.decision !== "deny") {
    errors.push('auth.decision must be exactly "allow" or "deny"');
  }
  if (auth.reason !== null && typeof auth.reason !== "string") {
    errors.push("auth.reason must be a string or null");
  }
}

function validateSideEffects(sideEffects, errors) {
  if (!requireArray(sideEffects, "sideEffects", errors)) return;
  for (const [index, effect] of sideEffects.entries()) {
    const label = `sideEffects[${index}]`;
    if (!requirePlainObject(effect, label, errors)) continue;
    requireNonEmptyString(effect.kind, `${label}.kind`, errors);
    requireNonEmptyString(effect.target, `${label}.target`, errors);
    if (!Object.hasOwn(effect, "detail")) errors.push(`${label}.detail must be present`);
  }
}

// Components a subject can meter. `durationMs` is reported but never compared —
// timing is performance and performance parity is WIN-285's gate battery.
export const USAGE_COMPONENTS = Object.freeze(["inputUnits", "outputUnits", "costMicros"]);

function validateUsage(usage, errors) {
  if (!requirePlainObject(usage, "usage", errors)) return;
  for (const field of [...USAGE_COMPONENTS, "durationMs"]) {
    if (requireFiniteNumber(usage[field], `usage.${field}`, errors) && usage[field] < 0) {
      errors.push(`usage.${field} must not be negative`);
    }
  }
  // A subject must say WHICH components it actually meters. Without this a
  // subject that does not model cost still reports `costMicros: 0`, both sides
  // agree on zero, and the usage dimension records agreement about a number
  // neither side ever measured. Declaring the measured set turns that from a
  // silent constant into a stated limit the coverage matrix can read.
  if (!requireArray(usage.measured, "usage.measured", errors)) return;
  for (const field of usage.measured) {
    if (!USAGE_COMPONENTS.includes(field)) errors.push(`usage.measured names unknown component ${field}`);
  }
  if (new Set(usage.measured).size !== usage.measured.length) {
    errors.push("usage.measured must not repeat a component");
  }
}

function validateStore(store, errors) {
  if (!requirePlainObject(store, "store", errors)) return;
  for (const [table, rows] of Object.entries(store)) {
    const label = `store[${table}]`;
    if (!requireArray(rows, label, errors)) continue;
    for (const [index, row] of rows.entries()) requirePlainObject(row, `${label}[${index}]`, errors);
  }
}

export function validateObservation(observation) {
  const errors = [];
  if (!requirePlainObject(observation, "observation", errors)) return errors;
  requireNonEmptyString(observation.scenario, "observation.scenario", errors);
  if (!SIDES.includes(observation.side)) {
    errors.push(`observation.side must be one of ${SIDES.join(", ")}`);
  }
  requireNonEmptyString(observation.subject, "observation.subject", errors);
  // Optional overall — a subject with no store legitimately has none — but when
  // present it must be a real name. `storeIdentity: ""` would compare equal
  // across both sides and silently defeat the isolation assertion in twinRun.
  if (observation.storeIdentity !== undefined && observation.storeIdentity !== null) {
    requireNonEmptyString(observation.storeIdentity, "observation.storeIdentity", errors);
  }
  validateResponse(observation.response, errors);
  validateEvents(observation.events, errors);
  validateAuth(observation.auth, errors);
  validateSideEffects(observation.sideEffects, errors);
  validateUsage(observation.usage, errors);
  validateStore(observation.store, errors);
  return errors;
}

export function assertObservation(observation) {
  const errors = validateObservation(observation);
  if (errors.length) {
    const label = observation?.scenario ?? "<unnamed>";
    throw new Error(`invalid observation for ${label}: ${errors.join("; ")}`);
  }
  return observation;
}

// ---------------------------------------------------------------------------
// Comparable-fact counting — the anti-vacuity primitive
// ---------------------------------------------------------------------------

// How many independently comparable facts a dimension actually carries in this
// observation. Zero means the dimension was not exercised, which the twin-run
// treats as a failure for any dimension the scenario declared. This is the
// counter that stops "both sides produced nothing" from being reported as
// parity — the same failure class as an architecture gate that scans zero
// files and reports green.
export function countComparableFacts(observation, dimension) {
  switch (dimension) {
    case "status":
      return Number.isInteger(observation.response?.status) ? 1 : 0;
    case "schema":
      return countSchemaLeaves(observation.response?.body);
    case "events":
      return observation.events?.length ?? 0;
    case "auth":
      // principal + decision are always readable; scopes and reason add one
      // each only when populated, so an all-empty auth block still counts 2
      // and can never be zero. That is deliberate: auth is never "absent",
      // an unauthenticated call is itself an auth fact.
      return 2 + (observation.auth?.scopes?.length ?? 0) + (observation.auth?.reason ? 1 : 0);
    case "sideEffects":
      return observation.sideEffects?.length ?? 0;
    case "usage":
      // Only metered components count. A subject that meters nothing makes the
      // usage dimension vacuous and the run is refused, rather than recording
      // agreement about three zeroes nobody measured.
      return observation.usage?.measured?.length ?? 0;
    case "store":
      return Object.values(observation.store ?? {}).reduce((total, rows) => total + rows.length, 0);
    default:
      throw new Error(`unknown dimension ${dimension}`);
  }
}

// A leaf is a scalar position in the body. `null` and `[]` and `{}` are leaves
// too — "this position exists and is empty" is a comparable fact, and a body
// that is exactly `null` still carries one fact rather than none.
export function countSchemaLeaves(body) {
  if (body === null || typeof body !== "object") return 1;
  if (Array.isArray(body)) {
    return body.length === 0 ? 1 : body.reduce((total, entry) => total + countSchemaLeaves(entry), 0);
  }
  const entries = Object.values(body);
  return entries.length === 0 ? 1 : entries.reduce((total, entry) => total + countSchemaLeaves(entry), 0);
}
