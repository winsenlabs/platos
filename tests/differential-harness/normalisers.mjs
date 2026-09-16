// WIN-284 — the normalisation register.
//
// Twin-running two independent stores produces values that differ for reasons
// that are not drift: clocks advance, identifiers are random, the two stores
// bind different ports, sequences start independently. Those have to be erased
// or every run is red and the harness gets muted.
//
// An over-broad normaliser is the opposite and worse failure. It erases real
// drift, the report reads green, and nobody ever learns the harness stopped
// measuring. That is the same vacuity class as a gate that scans zero files
// and reports success — a green check that was never shown to be capable of
// going red.
//
// So every normaliser in this register carries FOUR mandatory declarations:
//
//   erases     — prose: the nondeterministic component it removes
//   preserves  — prose: the observable it must still let through
//   sensitivity.equivalent — a pair differing ONLY in the erased component.
//                            Normalising both MUST make them equal.
//   sensitivity.divergent  — a pair differing in a REAL way inside the same
//                            field family. Normalising both MUST leave them
//                            unequal.
//
// `assertRegisterIsSensitive` (exercised by normalisers.test.mjs) walks the
// whole register and enforces both directions. A normaliser added without a
// sensitivity pair fails; a normaliser whose reach is widened until it swallows
// its own divergent fixture fails. There is no way to add `s/.*/<any>/` here
// and have the suite stay green.

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const ULID_PATTERN = /\b[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}\b/gu;
const INSTANT_PATTERN =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?\b/gu;
// A SHA-256 hex digest. Narrow on purpose: exactly 64 lowercase hex characters,
// which is what `hashSecret` and `node-crypto-digest` both emit and what every
// `tokenHash` column in the tenancy schema holds. It cannot match a UUID (those
// carry dashes) and it cannot match a short identifier.
const DIGEST_PATTERN = /\b[0-9a-f]{64}\b/gu;
const ENDPOINT_PATTERN =
  /\b((?:postgres(?:ql)?|redis|https?|clickhouse|amqp):\/\/)(?:[^@/\s]*@)?([^/\s?#]+)/giu;

// Field names whose numeric value is a measured duration. Deliberately an
// exact allowlist rather than a suffix rule: a suffix rule would also swallow
// `retentionMs` or `budgetMs`, which are configuration and must diverge.
export const DURATION_FIELDS = Object.freeze(["durationMs", "elapsedMs", "latencyMs", "tookMs"]);

// `events` can never be order-normalised. Event ORDER is one of the seeded
// divergences this harness must catch, so sorting events would delete a
// negative control. Enforced in code, not left to reviewer discipline.
export const ORDER_LOCKED_COLLECTIONS = Object.freeze(["events"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapStrings(value, transform, key = null) {
  if (typeof value === "string") return transform(value, key);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, transform, key));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([field, entry]) => [field, mapStrings(entry, transform, field)]),
    );
  }
  return value;
}

// Object keys are visited in SORTED order, not insertion order. `identifier-
// ordinal` assigns ordinals by first appearance, so if two subjects built the
// same object with its keys in different orders — trivially possible once the
// oracle is a recording and the candidate is a live transport — the same
// identifier would get different ordinals on each side and the run would report
// a false divergence. Sorting makes the traversal a property of the content
// rather than of how each side happened to construct it. Array order is
// preserved, because array order IS content.
function collectStrings(value, visit) {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const entry of value) collectStrings(entry, visit);
  else if (isPlainObject(value)) {
    for (const key of Object.keys(value).sort()) collectStrings(value[key], visit);
  }
}

// ---------------------------------------------------------------------------
// store-row-canonical-order
// ---------------------------------------------------------------------------

// FOUND BY THE TWIN-POSTGRESQL RUN, not by reasoning about it.
//
// `identifier-ordinal` numbers identifiers by FIRST APPEARANCE. A store dump
// ordered by a UUID primary key comes back in an order that is effectively
// random and differs between two isolated stores, so the same logical row got a
// different ordinal on each side and the run reported store-row-missing and
// store-row-extra for rows that were identical. A FALSE POSITIVE, and an
// intermittent one — it passed twice before it failed.
//
// The fix is to make ordinal assignment depend on content instead of physical
// order: rows are sorted by their own content with identifier-shaped and
// instant-shaped values masked out, which is stable across two stores because
// it uses only the parts neither store randomises.
//
// This erases nothing that was ever compared. `compareStore` treats a table as
// a MULTISET, so row order carries no signal for it to lose; the ordering
// exists solely so identifier ordinals line up. Its divergent fixture proves
// that: two tables with different row CONTENT still diverge after sorting.
const MASK_PATTERNS = [
  [UUID_PATTERN, "<uuid>"],
  [ULID_PATTERN, "<ulid>"],
  [INSTANT_PATTERN, "<instant>"],
  // WIN-257. A digest is minted from a random token, so two independent systems
  // never agree on one and it belongs in the mask for exactly the reason the
  // three above do: the sort key must use only the parts neither store
  // randomises, or the same logical row gets a different ordinal on each side.
  [DIGEST_PATTERN, "<digest>"],
];

function maskNondeterminism(text) {
  let masked = text;
  for (const [pattern, token] of MASK_PATTERNS) masked = masked.replace(pattern, token);
  return masked;
}

function canonicalSortKey(row) {
  const ordered = Object.keys(row ?? {})
    .sort()
    .map((field) => [field, row[field]]);
  return maskNondeterminism(JSON.stringify(ordered));
}

function applyStoreRowCanonicalOrder(observation) {
  if (!isPlainObject(observation.store)) return observation;
  const store = {};
  for (const [table, rows] of Object.entries(observation.store)) {
    store[table] = Array.isArray(rows)
      ? [...rows].sort((left, right) => {
          const leftKey = canonicalSortKey(left);
          const rightKey = canonicalSortKey(right);
          return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        })
      : rows;
  }
  return { ...observation, store };
}

// ---------------------------------------------------------------------------
// instant-rank
// ---------------------------------------------------------------------------

function rankInstants(observation) {
  const seen = new Set();
  collectStrings(observation, (text) => {
    for (const match of text.matchAll(INSTANT_PATTERN)) seen.add(match[0]);
  });
  const ordered = [...seen].sort((left, right) => {
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) return left < right ? -1 : left > right ? 1 : 0;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const ranks = new Map();
  ordered.forEach((instant, index) => ranks.set(instant, index));
  return ranks;
}

function applyInstantRank(observation) {
  const ranks = rankInstants(observation);
  return mapStrings(observation, (text) =>
    text.replace(INSTANT_PATTERN, (match) => `<instant:${ranks.get(match)}>`),
  );
}

// ---------------------------------------------------------------------------
// identifier-ordinal
// ---------------------------------------------------------------------------

function applyIdentifierOrdinal(observation) {
  const ordinals = new Map();
  const assign = (value) => {
    if (!ordinals.has(value)) ordinals.set(value, ordinals.size);
    return `<id:${ordinals.get(value)}>`;
  };
  // Two passes: assign ordinals in a deterministic document order first, then
  // rewrite. A single pass would make the ordinal depend on JavaScript object
  // key iteration order, which is stable here but not something to rely on
  // across two subjects that build their objects differently.
  collectStrings(observation, (text) => {
    for (const match of text.matchAll(UUID_PATTERN)) assign(match[0].toLowerCase());
    for (const match of text.matchAll(ULID_PATTERN)) assign(match[0]);
  });
  return mapStrings(observation, (text) =>
    text
      .replace(UUID_PATTERN, (match) => assign(match.toLowerCase()))
      .replace(ULID_PATTERN, (match) => assign(match)),
  );
}

// ---------------------------------------------------------------------------
// instant-presence
// ---------------------------------------------------------------------------

// WIN-257 — THE ONE NORMALISER A TRANSPORT DIFFERENTIAL NEEDS AND A STORE
// CONSERVATION RUN MUST NOT USE.
//
// `instant-rank` erases the VALUE of an instant and keeps its RANK, so a
// reordering still diverges. That is exactly right when both sides run identical
// SQL against two databases: the same operations in the same order produce the
// same NUMBER of distinct instants, and a difference in the count is real drift.
//
// It is wrong across two IMPLEMENTATIONS. The webapp writes a project and its
// membership inside one Prisma transaction whose `now()` is evaluated once;
// core-api writes the same rows through its own unit of work and may stamp two
// instants a millisecond apart. Neither is a defect, and neither side's count is
// the "right" one — so the ranks shift, every later instant in the observation
// renumbers, and rows that agree in every meaningful column are reported missing
// and extra. Independent verification of that behaviour is what put this
// normaliser here rather than an approval over the whole row.
//
// WHAT IT KEEPS: whether a timestamp column was written AT ALL. `null` stays
// `null` and an instant becomes `<instant>`, so a side that leaves `revokedAt`
// unset while the other revokes, or leaves `lastSeenAt` unstamped while the
// other stamps it, still diverges — which is the class of difference a transport
// differential is actually for.
//
// WHAT IT LOSES, STATED: order and count. A scenario that uses it CANNOT catch a
// reordering of two timestamps, and `transport-scenarios.mjs` has to say in prose
// why it is willing to give that up.
function applyInstantPresence(observation) {
  return mapStrings(observation, (text) => text.replace(INSTANT_PATTERN, "<instant>"));
}

// ---------------------------------------------------------------------------
// digest-ordinal
// ---------------------------------------------------------------------------

// WIN-257 — THE SAME CLASS OF NONDETERMINISM AS A UUID, AND FOUND THE SAME WAY.
//
// The transport differential twin-runs a real sign-in against two systems. Each
// mints its own session token and its own magic-link token, and the schema
// stores the SHA-256 of each. Those digests differ by construction, exactly as
// two independently minted UUIDs do, and the twin-store run reported
// store-row-missing plus store-row-extra for `OperatorSession` and
// `MagicLinkToken` rows that agreed in every column that carries meaning.
//
// So digests are numbered rather than compared, and the SAME rule as
// `identifier-ordinal` applies: the VALUE goes, the STRUCTURE stays. One digest
// used in two places is a different fact from two distinct digests, and a side
// emitting a different NUMBER of digests still diverges — which is what catches
// a session that was minted twice, or a token whose hash was written into the
// wrong row.
function applyDigestOrdinal(observation) {
  const ordinals = new Map();
  const assign = (value) => {
    if (!ordinals.has(value)) ordinals.set(value, ordinals.size);
    return `<digest:${ordinals.get(value)}>`;
  };
  collectStrings(observation, (text) => {
    for (const match of text.matchAll(DIGEST_PATTERN)) assign(match[0]);
  });
  return mapStrings(observation, (text) => text.replace(DIGEST_PATTERN, (match) => assign(match)));
}

// ---------------------------------------------------------------------------
// duration-elided
// ---------------------------------------------------------------------------

function elideDurations(value, key = null) {
  if (typeof value === "number" && key !== null && DURATION_FIELDS.includes(key)) return "<duration>";
  if (Array.isArray(value)) return value.map((entry) => elideDurations(entry, key));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([field, entry]) => [field, elideDurations(entry, field)]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// ephemeral-endpoint
// ---------------------------------------------------------------------------

function applyEphemeralEndpoint(observation) {
  return mapStrings(observation, (text) =>
    text.replace(ENDPOINT_PATTERN, (_match, scheme) => `${scheme}<endpoint>`),
  );
}

// ---------------------------------------------------------------------------
// store-sequence-ordinal
// ---------------------------------------------------------------------------

// Integer surrogate keys start independently in two isolated stores. Rewriting
// them to per-table ordinals keeps every join intact — a row that pointed at
// key 4 still points at whatever ordinal key 4 became — while erasing the
// absolute value the two stores were never going to agree on.
export const SEQUENCE_FIELDS = Object.freeze(["id", "seq", "sequence", "ordinal", "rowId"]);

function applyStoreSequenceOrdinal(observation) {
  if (!isPlainObject(observation.store)) return observation;
  const store = {};
  for (const [table, rows] of Object.entries(observation.store)) {
    const ordinals = new Map();
    for (const row of rows) {
      for (const field of SEQUENCE_FIELDS) {
        if (typeof row?.[field] === "number" && Number.isInteger(row[field])) {
          const token = `${table}:${field}:${row[field]}`;
          if (!ordinals.has(token)) ordinals.set(token, ordinals.size);
        }
      }
    }
    store[table] = rows.map((row) => {
      const rewritten = { ...row };
      for (const field of SEQUENCE_FIELDS) {
        if (typeof row?.[field] === "number" && Number.isInteger(row[field])) {
          rewritten[field] = `<seq:${ordinals.get(`${table}:${field}:${row[field]}`)}>`;
        }
      }
      return rewritten;
    });
  }
  return { ...observation, store };
}

// ---------------------------------------------------------------------------
// declared-unordered-sort
// ---------------------------------------------------------------------------

// Applied ONLY to collections a scenario names in `unorderedCollections`. Two
// stores returning the same set of rows in a different physical order is not
// drift; two stores emitting the same events in a different order IS drift, so
// `events` is refused outright.
export function sortDeclaredUnordered(observation, unorderedCollections = []) {
  let next = observation;
  for (const path of unorderedCollections) {
    const [head] = path.split(".");
    if (ORDER_LOCKED_COLLECTIONS.includes(head)) {
      throw new Error(
        `${path} cannot be declared unordered: ${head} order is a seeded divergence this harness must detect`,
      );
    }
    next = sortAtPath(next, path.split("."));
  }
  return next;
}

function sortAtPath(value, segments) {
  if (segments.length === 0) {
    if (!Array.isArray(value)) return value;
    return [...value].sort((left, right) => {
      const leftKey = JSON.stringify(left);
      const rightKey = JSON.stringify(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  }
  const [head, ...rest] = segments;
  if (Array.isArray(value)) return value.map((entry) => sortAtPath(entry, segments));
  if (!isPlainObject(value) || !Object.hasOwn(value, head)) return value;
  return { ...value, [head]: sortAtPath(value[head], rest) };
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

export const NORMALISERS = Object.freeze([
  // MUST run before identifier-ordinal: it is what makes first-appearance
  // ordinals stable across two stores.
  Object.freeze({
    id: "store-row-canonical-order",
    dimensions: Object.freeze(["store"]),
    erases: "The physical order rows are returned in by an unordered store dump, which two isolated stores keyed by random identifiers do not agree on.",
    preserves:
      "Row content and multiset membership in full. The store comparator already compares a table as a multiset, so ordering carried no signal for this to lose; it exists only so identifier ordinals line up across the two sides.",
    apply: applyStoreRowCanonicalOrder,
    sensitivity: Object.freeze({
      equivalent: Object.freeze([
        { store: { project: [{ slug: "alpha" }, { slug: "beta" }] } },
        { store: { project: [{ slug: "beta" }, { slug: "alpha" }] } },
      ]),
      divergent: Object.freeze([
        { store: { project: [{ slug: "alpha" }, { slug: "beta" }] } },
        { store: { project: [{ slug: "alpha" }, { slug: "gamma" }] } },
      ]),
    }),
  }),
  Object.freeze({
    id: "instant-rank",
    dimensions: Object.freeze(["schema", "events", "sideEffects", "store"]),
    erases: "The wall-clock value of every ISO-8601 instant. Two isolated stores are written at different moments and will never agree on an absolute time.",
    preserves:
      "Presence, count, and RELATIVE ORDER. An instant is replaced by its rank within the observation's sorted set of instants, so a dropped timestamp, an extra timestamp, or two events swapped in time all still diverge.",
    apply: applyInstantRank,
    sensitivity: Object.freeze({
      equivalent: Object.freeze([
        { events: [{ name: "created", payload: { at: "2026-09-02T10:00:00.000Z" } }] },
        { events: [{ name: "created", payload: { at: "2026-09-02T11:30:45.123Z" } }] },
      ]),
      divergent: Object.freeze([
        {
          events: [
            { name: "created", payload: { at: "2026-09-02T10:00:00.000Z" } },
            { name: "closed", payload: { at: "2026-09-02T10:00:05.000Z" } },
          ],
        },
        {
          events: [
            { name: "created", payload: { at: "2026-09-02T10:00:05.000Z" } },
            { name: "closed", payload: { at: "2026-09-02T10:00:00.000Z" } },
          ],
        },
      ]),
    }),
  }),
  Object.freeze({
    id: "identifier-ordinal",
    dimensions: Object.freeze(["schema", "events", "sideEffects", "store"]),
    erases: "The random value of UUID and ULID identifiers, which two isolated stores generate independently.",
    preserves:
      "Referential structure and count. Ordinals are assigned over a key-sorted traversal, so a side that reuses one identifier where the other uses two distinct ones still diverges, as does a side emitting a different NUMBER of identifiers. STATED LIMIT: a permutation of identifiers that each appear exactly once and never co-occur is NOT observable, because which random value a store minted for which row is precisely the nondeterminism being erased.",
    apply: applyIdentifierOrdinal,
    sensitivity: Object.freeze({
      equivalent: Object.freeze([
        {
          store: {
            thread: [{ ref: "0b8f2a4c-1d3e-4f5a-8b9c-0d1e2f3a4b5c", owner: "0b8f2a4c-1d3e-4f5a-8b9c-0d1e2f3a4b5c" }],
          },
        },
        {
          store: {
            thread: [{ ref: "7c9e1b2d-3f4a-4b6c-9d8e-1a2b3c4d5e6f", owner: "7c9e1b2d-3f4a-4b6c-9d8e-1a2b3c4d5e6f" }],
          },
        },
      ]),
      divergent: Object.freeze([
        {
          store: {
            thread: [{ ref: "0b8f2a4c-1d3e-4f5a-8b9c-0d1e2f3a4b5c", owner: "0b8f2a4c-1d3e-4f5a-8b9c-0d1e2f3a4b5c" }],
          },
        },
        {
          store: {
            thread: [{ ref: "0b8f2a4c-1d3e-4f5a-8b9c-0d1e2f3a4b5c", owner: "7c9e1b2d-3f4a-4b6c-9d8e-1a2b3c4d5e6f" }],
          },
        },
      ]),
    }),
  }),
  Object.freeze({
    id: "instant-presence",
    dimensions: Object.freeze(["schema", "events", "sideEffects", "store"]),
    erases: "The value, the order and the count of ISO-8601 instants, leaving only whether a timestamp was written at all.",
    preserves:
      "Presence. A column that one side wrote and the other left null still diverges, which is the difference a transport differential exists to find. STATED LOSS: order and count both go, so a scenario that uses this cannot catch a reordering of two timestamps and must say in prose why it is willing to give that up. It runs AFTER instant-rank and therefore matches nothing unless a scenario has skipped that one.",
    apply: applyInstantPresence,
    sensitivity: Object.freeze({
      equivalent: Object.freeze([
        { store: { session: [{ createdAt: "2026-09-16T00:00:00.000Z", lastSeenAt: "2026-09-16T00:00:01.000Z" }] } },
        { store: { session: [{ createdAt: "2026-09-16T00:00:02.000Z", lastSeenAt: "2026-09-16T00:00:02.000Z" }] } },
      ]),
      divergent: Object.freeze([
        { store: { session: [{ createdAt: "2026-09-16T00:00:00.000Z", lastSeenAt: "2026-09-16T00:00:01.000Z" }] } },
        { store: { session: [{ createdAt: "2026-09-16T00:00:00.000Z", lastSeenAt: null }] } },
      ]),
    }),
  }),
  Object.freeze({
    id: "digest-ordinal",
    dimensions: Object.freeze(["schema", "events", "sideEffects", "store"]),
    erases: "The value of every SHA-256 hex digest, which two systems that each minted their own token can never agree on.",
    preserves:
      "Referential structure and count, exactly as identifier-ordinal does for UUIDs. One digest appearing in two rows stays one digest; two distinct digests stay two; a side that writes a different NUMBER of digests still diverges. STATED LIMIT: which digest a system happened to mint for which row is precisely the nondeterminism being erased, so a permutation of digests that each appear once and never co-occur is not observable.",
    apply: applyDigestOrdinal,
    sensitivity: Object.freeze({
      equivalent: Object.freeze([
        { store: { session: [{ tokenHash: "a".repeat(64), previousHash: "a".repeat(64) }] } },
        { store: { session: [{ tokenHash: "b".repeat(64), previousHash: "b".repeat(64) }] } },
      ]),
      divergent: Object.freeze([
        { store: { session: [{ tokenHash: "a".repeat(64), previousHash: "a".repeat(64) }] } },
        { store: { session: [{ tokenHash: "a".repeat(64), previousHash: "c".repeat(64) }] } },
      ]),
    }),
  }),
  Object.freeze({
    id: "duration-elided",
    dimensions: Object.freeze(["usage"]),
    erases: "The magnitude of measured durations, entirely. This normaliser is deliberately lossy and is the only one that is.",
    preserves:
      "Presence and type only. Timing is a performance property; performance parity is WIN-285's gate battery, not this issue's. The scope is an exact field allowlist, never a `*Ms` suffix rule, so a configured `retentionMs` or `budgetMs` is untouched and still diverges.",
    apply: (observation) => elideDurations(observation),
    sensitivity: Object.freeze({
      equivalent: Object.freeze([
        { usage: { durationMs: 12 } },
        { usage: { durationMs: 4210 } },
      ]),
      divergent: Object.freeze([
        { usage: { durationMs: 12, retentionMs: 1000 } },
        { usage: { durationMs: 4210, retentionMs: 2000 } },
      ]),
    }),
  }),
  Object.freeze({
    id: "ephemeral-endpoint",
    dimensions: Object.freeze(["schema", "events", "sideEffects", "store"]),
    erases: "The host and port authority of a connection string or URL. Twin stores bind different ephemeral ports by construction.",
    preserves:
      "Scheme, path, database name, and query string. A side that connected over a different scheme, or reached a different database on the same host, still diverges.",
    apply: applyEphemeralEndpoint,
    sensitivity: Object.freeze({
      equivalent: Object.freeze([
        { sideEffects: [{ kind: "connect", target: "postgresql://user:pw@127.0.0.1:54321/twin", detail: null }] },
        { sideEffects: [{ kind: "connect", target: "postgresql://user:pw@127.0.0.1:61887/twin", detail: null }] },
      ]),
      divergent: Object.freeze([
        { sideEffects: [{ kind: "connect", target: "postgresql://user:pw@127.0.0.1:54321/twin", detail: null }] },
        { sideEffects: [{ kind: "connect", target: "postgresql://user:pw@127.0.0.1:54321/other", detail: null }] },
      ]),
    }),
  }),
  Object.freeze({
    id: "store-sequence-ordinal",
    dimensions: Object.freeze(["store"]),
    erases: "The absolute value of integer surrogate keys, which two isolated stores allocate from independent sequences.",
    preserves:
      "Row count, row order, and every join. Keys become per-table ordinals by first appearance, so a missing row, an extra row, or a row pointing at a different parent all still diverge.",
    apply: applyStoreSequenceOrdinal,
    sensitivity: Object.freeze({
      equivalent: Object.freeze([
        { store: { turn: [{ id: 1, label: "a" }, { id: 2, label: "b" }] } },
        { store: { turn: [{ id: 41, label: "a" }, { id: 42, label: "b" }] } },
      ]),
      divergent: Object.freeze([
        { store: { turn: [{ id: 1, label: "a" }, { id: 2, label: "b" }] } },
        { store: { turn: [{ id: 41, label: "a" }, { id: 42, label: "CHANGED" }] } },
      ]),
    }),
  }),
]);

export function normaliserById(id) {
  const found = NORMALISERS.find((normaliser) => normaliser.id === id);
  if (!found) throw new Error(`unknown normaliser ${id}`);
  return found;
}

// Applies the register in declared order. Order matters and is fixed:
// identifier-ordinal runs before store-sequence-ordinal so a UUID primary key
// is already an ordinal token and is not also read as an integer sequence.
export function normalise(observation, options = {}) {
  const skip = new Set(options.skip ?? []);
  let next = sortDeclaredUnordered(observation, options.unorderedCollections ?? []);
  for (const normaliser of NORMALISERS) {
    if (skip.has(normaliser.id)) continue;
    next = normaliser.apply(next);
  }
  return next;
}

// ---------------------------------------------------------------------------
// The register's own non-vacuity guard
// ---------------------------------------------------------------------------

const REQUIRED_DECLARATIONS = Object.freeze(["id", "dimensions", "erases", "preserves", "apply", "sensitivity"]);

export function assertRegisterIsSensitive(register = NORMALISERS) {
  const failures = [];
  const seen = new Set();
  for (const normaliser of register) {
    const label = normaliser?.id ?? "<unnamed>";
    for (const field of REQUIRED_DECLARATIONS) {
      if (normaliser?.[field] === undefined) failures.push(`${label} is missing ${field}`);
    }
    if (seen.has(label)) failures.push(`${label} is declared twice`);
    seen.add(label);
    if (typeof normaliser?.erases === "string" && normaliser.erases.trim().length < 40) {
      failures.push(`${label}.erases must say what is removed, in prose`);
    }
    if (typeof normaliser?.preserves === "string" && normaliser.preserves.trim().length < 40) {
      failures.push(`${label}.preserves must say what still gets through, in prose`);
    }
    const pair = normaliser?.sensitivity;
    if (!pair?.equivalent || !pair?.divergent) {
      failures.push(`${label} has no sensitivity pair; it cannot be shown to be correctly scoped`);
      continue;
    }
    const [equivalentLeft, equivalentRight] = pair.equivalent;
    if (JSON.stringify(equivalentLeft) === JSON.stringify(equivalentRight)) {
      failures.push(`${label}.sensitivity.equivalent is a pair of identical inputs, which proves nothing`);
    }
    if (
      JSON.stringify(normaliser.apply(equivalentLeft)) !== JSON.stringify(normaliser.apply(equivalentRight))
    ) {
      failures.push(`${label} failed to erase its own declared nondeterminism`);
    }
    const [divergentLeft, divergentRight] = pair.divergent;
    if (JSON.stringify(divergentLeft) === JSON.stringify(divergentRight)) {
      failures.push(`${label}.sensitivity.divergent is a pair of identical inputs, which proves nothing`);
    }
    if (
      JSON.stringify(normaliser.apply(divergentLeft)) === JSON.stringify(normaliser.apply(divergentRight))
    ) {
      failures.push(`${label} is OVER-BROAD: it erased a real difference in the field family it normalises`);
    }
  }
  return failures;
}
