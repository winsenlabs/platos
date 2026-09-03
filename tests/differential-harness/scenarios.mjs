// WIN-284 — the scenario registry, and the ONLY source of coverage claims.
//
// `scripts/differential-coverage.mjs` computes the covered side of the
// capability matrix from this file. Coverage is therefore derived from what the
// harness actually runs, never written by hand into the matrix — a matrix whose
// covered column can be edited independently of the scenarios is a matrix that
// will eventually claim coverage nobody has.
//
// Each scenario declares `capabilities`: the exact census cell ids it exercises.
// The generator rejects a claim that names a cell no census contains, so a typo
// or an invented capability fails rather than quietly inflating the numerator.
//
// The list is short today and it is supposed to be. At this baseline there is no
// V1 REST, MCP, SDK, channel or stream implementation to twin-run against — the
// M4/M5/M6 issues that build them were removed from this issue's blockers
// precisely because they gate COVERAGE, not CONSTRUCTION. Every cell they will
// eventually fill is enumerated as `uncovered` with its blocking milestone, so
// the denominator cannot shrink and the gap stays visible.

const ORGANIZATION_SLUG = "win284-conservation";

// Real tenancy tables, a real foreign key and a real cascade, so "state
// conservation" is checkable against internal-packages/tenancy-database rather
// than against a fixture invented to make the harness look good.
//
// TIMESTAMP NOTE: each operation is its own `psql` process, so two operations
// cannot land in the same millisecond in practice and instant-rank sees the
// same number of distinct instants on both sides. If they ever did tie, the
// ranks would differ and the run would report a FALSE POSITIVE — never a false
// negative. That is the safe direction for a harness to fail in.
//
// DIMENSIONS NOTE: this scenario declares all seven, and the store runner's
// `dimension-sensitivity` phase requires every one of them to have been seen to
// diverge ON THIS SCENARIO. Declaring a dimension here is therefore an
// obligation to seed it, not a free line in `factCounts`. `auth` and `status`
// were declared and structurally constant until the tier-downgrade and
// undefined-table seeds were added; the phase exists so that cannot recur
// silently.
export const CONSERVATION_SCENARIO = Object.freeze({
  id: "tenancy-organization-project-conservation",
  title: "Organization and Project lifecycle conserved across two isolated stores",
  subject: "postgres-twin",
  capabilities: Object.freeze(["store:Organization", "store:Project"]),
  dimensions: Object.freeze(["status", "schema", "events", "auth", "sideEffects", "usage", "store"]),
  storeTables: Object.freeze(["Organization", "Project"]),
  resultOf: "select-projects",
  sideEffectVerbs: Object.freeze({
    "insert-organization": "insert",
    "insert-project-alpha": "insert",
    "insert-project-beta": "insert",
    "archive-project-beta": "update",
  }),
  operations: Object.freeze([
    Object.freeze({
      id: "insert-organization",
      target: "Organization",
      sql: `INSERT INTO public."Organization" (id, slug, name, "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), '${ORGANIZATION_SLUG}', 'WIN-284 conservation', now(), now())
            RETURNING slug, name`,
    }),
    Object.freeze({
      id: "insert-project-alpha",
      target: "Project",
      sql: `INSERT INTO public."Project" (id, "organizationId", slug, name, "createdAt", "updatedAt")
            SELECT gen_random_uuid(), o.id, 'alpha', 'Alpha', now(), now()
            FROM public."Organization" o WHERE o.slug = '${ORGANIZATION_SLUG}'
            RETURNING slug, name`,
    }),
    Object.freeze({
      id: "insert-project-beta",
      target: "Project",
      sql: `INSERT INTO public."Project" (id, "organizationId", slug, name, "createdAt", "updatedAt")
            SELECT gen_random_uuid(), o.id, 'beta', 'Beta', now(), now()
            FROM public."Organization" o WHERE o.slug = '${ORGANIZATION_SLUG}'
            RETURNING slug, name`,
    }),
    Object.freeze({
      id: "archive-project-beta",
      target: "Project",
      sql: `UPDATE public."Project" SET "archivedAt" = now(), "updatedAt" = now()
            WHERE slug = 'beta' RETURNING slug, name`,
    }),
    Object.freeze({
      id: "select-projects",
      sql: `SELECT slug, name, ("archivedAt" IS NOT NULL) AS archived
            FROM public."Project" ORDER BY slug`,
    }),
  ]),
});

// The end-user tier boundary, enforced by PostgreSQL from grants derived at run
// time from the model list in prisma/end-user.prisma. The denial is a real
// 42501 from the database, not a rule the harness wrote for itself.
export const TIER_BOUNDARY_SCENARIO = Object.freeze({
  id: "tenancy-end-user-tier-boundary",
  title: "The end-user tier cannot read an operator-only table",
  subject: "postgres-twin",
  capabilities: Object.freeze(["store:Organization"]),
  dimensions: Object.freeze(["status", "events", "auth"]),
  resultOf: "read-operator-table",
  operations: Object.freeze([
    Object.freeze({
      id: "read-operator-table",
      role: "restricted",
      sql: `SELECT slug FROM public."Organization"`,
    }),
  ]),
});

export const SCENARIO_REGISTRY = Object.freeze([CONSERVATION_SCENARIO, TIER_BOUNDARY_SCENARIO]);

// The union of every capability any registered scenario twin-runs. This is the
// numerator of the coverage matrix and it is computed, never declared.
export function claimedCapabilities(registry = SCENARIO_REGISTRY) {
  const claims = new Set();
  for (const scenario of registry) for (const capability of scenario.capabilities ?? []) claims.add(capability);
  return [...claims].sort();
}

export function assertRegistryIsWellFormed(registry = SCENARIO_REGISTRY) {
  const failures = [];
  const seen = new Set();
  for (const scenario of registry) {
    if (seen.has(scenario.id)) failures.push(`scenario ${scenario.id} is registered twice`);
    seen.add(scenario.id);
    if (!Array.isArray(scenario.dimensions) || scenario.dimensions.length === 0) {
      failures.push(`scenario ${scenario.id} declares no dimensions`);
    }
    if (!Array.isArray(scenario.capabilities) || scenario.capabilities.length === 0) {
      // A scenario that claims nothing contributes nothing to coverage and
      // would sit in the registry looking like progress. Registered scenarios
      // must say which census cells they exercise.
      failures.push(`scenario ${scenario.id} claims no capability; it cannot contribute coverage`);
    }
    if (typeof scenario.subject !== "string" || scenario.subject.trim() === "") {
      failures.push(`scenario ${scenario.id} does not name the subject that runs it`);
    }
  }
  return failures;
}
