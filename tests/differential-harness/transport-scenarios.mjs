// WIN-257 / WIN-284 — THE SHIPPED-TRANSPORT SCENARIOS.
//
// `scenarios.mjs` holds the STORE scenarios: two isolated PostgreSQL databases
// driven by identical SQL. It says, in as many words, that at its baseline there
// was "no V1 REST, MCP, SDK, channel or stream implementation to twin-run
// against". For REST there is one now — organizations, projects, the end-user
// page, the session exchange and sign-out, the magic link, the environment scope
// and the environment variables are all served by `apps/core-api` — so this file
// is the registry for twin-running it against the thing it replaces.
//
// THE ORACLE IS THE WEBAPP, EXECUTED. Every oracle step runs a REAL Remix
// `loader` or `action` out of `apps/webapp/app/routes`, or a real export of
// `apps/webapp/app/services/auth.server`, against a real PostgreSQL.
// `apps/webapp/test/differential-oracle.mts` is the driver and it re-implements
// nothing: no Prisma query, no membership rule, no cookie format. A differential
// against a re-implementation compares two things one author wrote, which is the
// failure this whole harness exists to avoid.
//
// AND IT IS RECORDED, BECAUSE IT IS ABOUT TO BE DELETED. WIN-257 T8 deletes the
// webapp's Prisma access and `PlatosAuthService` with it. A scenario whose oracle
// has been deleted is a scenario that silently stops meaning anything, so every
// live oracle answer is written to `oracle-transcripts.json` with the digest of
// the source files that produced it. While those files exist the transcript must
// match what they answer today; once the cutover removes them the transcript is
// the frozen record of what they answered, and the candidate keeps being
// compared against it.
//
// WHAT THE `schema` DIMENSION COMPARES, AND WHY IT IS A PROJECTION.
//
// A Remix loader returns Prisma rows shaped for a screen; a V1 route returns an
// M0.4 envelope of resources. Those shapes differ ON PURPOSE and comparing them
// field for field would produce one approved difference per field, which is a
// blanket mute with extra steps. So each scenario declares an OBSERVABLE — the
// facts both sides must agree on, in one vocabulary — and each side projects into
// it. The projection is the one authored thing in this differential, so two
// defences stand under it:
//
//   * `store` compares RAW ROWS from the two databases, through no projection at
//     all. A projection that quietly agreed while the systems diverged would
//     still have to survive the row comparison.
//   * the sensitivity phase seeds real differences into the candidate's requests
//     and requires each declared dimension to be SEEN to diverge. A projection
//     that erased everything would fail it.
//
// HEADERS ARE NOT COMPARED, AND THAT IS A DECLARATION RATHER THAN AN OMISSION.
// A Remix `Response` and a Nest envelope legitimately differ in every header
// they carry, so comparing the sets would produce a wall of approvals. The one
// header that carries a fact this differential is about — `Set-Cookie` — is
// PROJECTED INTO THE BODY as `cookieName`, where it is compared like any other
// value. The comparator's refusal to let `set-cookie` be declared volatile is
// therefore not side-stepped: nothing is declared volatile, both sides present
// an empty header map, and the fact the header carried is compared elsewhere.
//
// ONE STATED WEAKENING against `postgres-conservation.mjs`'s rule. That runner
// requires every dimension to have a designated seed that moved it ON THAT
// SCENARIO. Here the obligation is per REGISTRY: every dimension any transport
// scenario declares must have exactly one designated seed, and that seed must
// have been seen to move it. Forty-eight seeds across twelve scenarios would be a
// phase nobody runs, and a weaker rule that is executed is worth more than a
// stronger one that is skipped — but it is weaker, and this is where that is
// written down rather than left for a reader to work out.

/** Every scenario in this file runs against the same pair of subjects. */
export const TRANSPORT_SUBJECT = "webapp-oracle-vs-core-api";

/**
 * The ONE normaliser every transport scenario turns off, and the reason.
 *
 * `instant-rank` keeps the RANK of each instant, so a reordering diverges. That
 * is right for two databases driven by identical SQL and wrong across two
 * IMPLEMENTATIONS: the webapp writes a project and its membership inside one
 * Prisma transaction whose `now()` is evaluated once, core-api writes the same
 * rows through its own unit of work and may stamp two instants a millisecond
 * apart, neither count is the correct one, and the renumbering reported rows as
 * missing and extra that agreed in every column carrying meaning. Measured on the
 * first real run of this suite, not reasoned about.
 *
 * `instant-presence` takes its place: value, order and count all go, and whether
 * a column was written at all stays. That is a REAL LOSS — these scenarios cannot
 * catch a reordering of two timestamps — and it is declared here rather than
 * applied quietly, because the alternative on offer was an approval over the
 * whole row, which would have muted every future difference in it.
 */
export const TRANSPORT_NORMALISATION = Object.freeze({
  skip: Object.freeze(["instant-rank"]),
  why:
    "Two independent implementations do not agree on how many distinct wall-clock instants one operation takes, so " +
    "instant RANKS renumber and rows that match in every meaningful column read as missing and extra. " +
    "instant-presence keeps the only timestamp fact a transport differential can honestly compare — whether the " +
    "column was written at all — and these scenarios give up catching a reordering of two timestamps to get it.",
});

function scenario(entry) {
  return Object.freeze({
    subject: TRANSPORT_SUBJECT,
    normalisation: TRANSPORT_NORMALISATION,
    dimensions: Object.freeze(["status", "schema", "auth", "store"]),
    ...entry,
    capabilities: Object.freeze(entry.capabilities),
    storeTables: Object.freeze(entry.storeTables),
    ...(entry.dimensions === undefined ? {} : { dimensions: Object.freeze(entry.dimensions) }),
    ...(entry.approvedDifferences === undefined
      ? {}
      : { approvedDifferences: Object.freeze(entry.approvedDifferences.map((approval) => Object.freeze(approval))) }),
  });
}

export const TRANSPORT_SCENARIO_REGISTRY = Object.freeze([
  scenario({
    id: "transport-magic-link-login",
    title: "A magic-link sign-in ends with the same session rows on both sides",
    capabilities: ["POST /api/v1/bff/magic-link", "POST /api/v1/bff/magic-link/complete"],
    oracleStep: "magic-link-login",
    storeTables: ["User", "OperatorSession", "MagicLinkToken"],
    observable: "signedIn, the cookie name the browser is given, and whether a redirect was issued",
    approvedDifferences: [
      {
        code: "status-changed",
        rationale:
          "The oracle's login action is a Remix form post and answers 302 with a Set-Cookie; the V1 BFF completes a " +
          "magic link as a JSON API and answers 200 with the session resource and the same Set-Cookie. Decision D20 " +
          "moved the email itself to the notifier-email adapter, so the V1 route never has a login-capable token to " +
          "redirect with. The session both sides end up holding is the fact under test, not the verb.",
        issue: "WIN-257",
      },
      {
        code: "schema-type-changed",
        path: "$.redirectTo",
        rationale:
          "Only the oracle redirects, so only the oracle names a location. This is the same intentional difference " +
          "as the status above, observed on the one projected field that carries it, and it is approved separately " +
          "so the approval is consumed once rather than muting the whole body.",
        issue: "WIN-257",
      },
      {
        code: "schema-value-changed",
        path: "$.redirectTo",
        rationale:
          "The comparator reports a string becoming null as BOTH a type change and a value change, and each is " +
          "consumed once. Approving only one would leave the other unapproved and the scenario permanently red; " +
          "approving the pair on this exact path still fails on any other field of the same body.",
        issue: "WIN-257",
      },
    ],
  }),
  scenario({
    id: "transport-identity-session",
    title: "Both sides resolve the same operator from the same cookie",
    capabilities: ["GET /api/v1/identity/session"],
    oracleStep: "identity-session",
    storeTables: ["OperatorSession"],
    observable: "authenticated, and the email the side attributes to the browser",
  }),
  scenario({
    id: "transport-session-exchange",
    title: "A token the caller already holds becomes the same cookie on both sides",
    capabilities: ["POST /api/v1/bff/session"],
    oracleStep: "session-exchange",
    storeTables: ["OperatorSession"],
    observable: "exchanged, and the cookie name the browser is given",
  }),
  scenario({
    id: "transport-organization-list",
    title: "The organizations an operator can see are the same set",
    capabilities: ["GET /api/v1/organizations"],
    oracleStep: "organization-list",
    storeTables: ["Organization", "OrganizationMembership"],
    observable: "the visible organizations by slug and name",
  }),
  scenario({
    id: "transport-project-list",
    title: "The projects an operator can see are the same set",
    capabilities: ["GET /api/v1/projects"],
    oracleStep: "project-list",
    storeTables: ["Project"],
    observable: "the visible projects by slug and name",
  }),
  scenario({
    id: "transport-organization-create",
    title: "Creating an organization leaves the same rows, including the founder's membership",
    capabilities: ["POST /api/v1/organizations"],
    oracleStep: "organization-create",
    storeTables: ["Organization", "OrganizationMembership"],
    observable: "created, and whether a redirect was issued",
    approvedDifferences: [
      {
        code: "status-changed",
        rationale:
          "A Remix action redirects a browser to the new resource and answers 302; a V1 REST create answers 201 with " +
          "the resource, and `session.controller.ts` records that the 201 here is earned rather than inherited from " +
          "Nest's default. The rows the two leave behind are the fact under test.",
        issue: "WIN-257",
      },
      {
        code: "schema-type-changed",
        path: "$.redirectTo",
        rationale:
          "Only the oracle redirects, so only the oracle names a location. Approved on the one field that carries " +
          "the difference rather than over the whole body.",
        issue: "WIN-257",
      },
      {
        code: "schema-value-changed",
        path: "$.redirectTo",
        rationale:
          "A string becoming null is reported as a type change AND a value change, and each approval is consumed " +
          "once. The pair is approved on this exact path only, so any other value difference in the same body fails.",
        issue: "WIN-257",
      },
    ],
  }),
  scenario({
    id: "transport-project-create",
    title: "Creating a project leaves the same project, environment and membership rows",
    capabilities: ["POST /api/v1/projects"],
    oracleStep: "project-create",
    storeTables: ["Project", "Environment", "ProjectMembership"],
    observable: "created, and whether a redirect was issued",
    approvedDifferences: [
      {
        code: "status-changed",
        rationale:
          "The same Remix-redirect versus REST-201 difference as the organization create above, and approved for the " +
          "same reason: the three rows this operation writes in one transaction are what the scenario is measuring.",
        issue: "WIN-257",
      },
      {
        code: "schema-type-changed",
        path: "$.redirectTo",
        rationale:
          "Only the oracle redirects. Approved on the single projected field that carries it, so a second, unrelated " +
          "value difference in the same body would still fail.",
        issue: "WIN-257",
      },
      {
        code: "schema-value-changed",
        path: "$.redirectTo",
        rationale:
          "A string becoming null is reported as a type change AND a value change, and each approval is consumed " +
          "once. The pair is approved on this exact path only, so any other value difference in the same body fails.",
        issue: "WIN-257",
      },
    ],
  }),
  scenario({
    id: "transport-end-user-page",
    title: "The end-user page shows the same accounts and the same total",
    capabilities: ["GET /api/v1/environments/:environmentId/end-users"],
    oracleStep: "end-user-page",
    storeTables: ["EndUser", "EndUserIdentity"],
    observable: "the listed end users by display name, and the total",
  }),
  scenario({
    id: "transport-environment-by-slugs",
    title: "Resolving an environment from slugs grants the same roles",
    capabilities: ["GET /api/v1/environments/by-slugs"],
    oracleStep: "environment-by-slugs",
    storeTables: ["Environment"],
    observable: "resolved, and the organization and project roles the grant carries",
  }),
  scenario({
    id: "transport-environment-variable-set",
    title: "Writing an environment variable leaves the same row",
    capabilities: ["PUT /api/v1/environments/:environmentId/variables/:key"],
    oracleStep: "environment-variable-set",
    storeTables: ["EnvironmentVariable"],
    observable: "written — whether the operator's write was accepted at the declared access level",
  }),
  scenario({
    id: "transport-environment-variable-list",
    title: "Listing environment variables reveals the same keys and the same plaintext",
    capabilities: ["GET /api/v1/environments/:environmentId/variables"],
    oracleStep: "environment-variable-list",
    storeTables: ["EnvironmentVariable"],
    observable: "each key, its kind, whether a value is present and whether the plaintext is visible",
  }),
  scenario({
    id: "transport-sign-out",
    title: "Signing out ends the session row on the server, not only in the browser",
    capabilities: ["DELETE /api/v1/bff/session"],
    oracleStep: "sign-out",
    storeTables: ["OperatorSession"],
    observable: "endedSession and cookieCleared",
    approvedDifferences: [
      {
        code: "status-changed",
        rationale:
          "The oracle's logout route redirects a browser to /login and answers 302; the V1 BFF answers 204, which is " +
          "what a JSON client can act on and what `session.controller.ts` records as the deliberate choice. The fact " +
          "under test is the one the old comment in that controller admitted was missing: that the SESSION ROW ends, " +
          "not only the cookie.",
        issue: "WIN-257",
      },
    ],
  }),
]);

/**
 * The designated seeds, and the dimension each one is the evidence for.
 *
 * Exactly one seed per declared dimension, and the sensitivity phase requires
 * that seed's run to have really moved it. "Some other phase happened to move
 * it" is not the same claim, and accepting it would make every seed deletable in
 * turn.
 *
 * `sideEffects` is deliberately NOT a declared dimension of these scenarios. The
 * only side effects observable across both subjects are the rows they write, and
 * a side-effect list derived from the store delta would be the store dimension
 * wearing a second name — a dimension carrying no independent fact, which
 * `twinRun` is right to treat as vacuous.
 */
export const TRANSPORT_SEEDS = Object.freeze([
  Object.freeze({
    id: "candidate-anonymous",
    scenario: "transport-organization-list",
    proves: Object.freeze(["status", "auth"]),
    describes:
      "The candidate asks for the organization list with no session cookie. The oracle still answers 200 for the " +
      "signed-in operator, so the status and the resolved principal both move.",
  }),
  Object.freeze({
    id: "candidate-truncated-page",
    scenario: "transport-organization-list",
    proves: Object.freeze(["schema"]),
    describes:
      "The candidate asks for one organization per page while the oracle reports every organization the operator can " +
      "see. Same status, same principal, a shorter set — which is exactly the regression a status-only comparison " +
      "reports as parity.",
  }),
  Object.freeze({
    id: "candidate-skips-write",
    scenario: "transport-environment-variable-set",
    proves: Object.freeze(["store"]),
    describes:
      "The oracle writes a second environment variable and the candidate does not. Both sides answer the same status " +
      "for the request they made; one database is short a row.",
  }),
]);

export function transportDimensions(registry = TRANSPORT_SCENARIO_REGISTRY) {
  const declared = new Set();
  for (const entry of registry) for (const dimension of entry.dimensions) declared.add(dimension);
  return [...declared].sort();
}

/**
 * Why this registry may not be believed, if anything.
 *
 * Every rule here is about a way the registry could contribute coverage it has
 * not earned: a scenario that names no capability, a scenario whose oracle step
 * nothing implements, an approval with no prose or no issue, and — the one that
 * matters most — a declared dimension with no designated seed, or two seeds
 * claiming the same one.
 */
export function assertTransportRegistryIsWellFormed(registry = TRANSPORT_SCENARIO_REGISTRY, seeds = TRANSPORT_SEEDS) {
  const failures = [];
  const ids = new Set();
  for (const entry of registry) {
    if (ids.has(entry.id)) failures.push(`scenario ${entry.id} is registered twice`);
    ids.add(entry.id);
    if (entry.capabilities.length === 0) failures.push(`scenario ${entry.id} claims no capability`);
    if (typeof entry.oracleStep !== "string" || entry.oracleStep === "") {
      failures.push(`scenario ${entry.id} names no oracle step, so nothing can execute its oracle`);
    }
    if (typeof entry.observable !== "string" || entry.observable.trim().length < 10) {
      failures.push(`scenario ${entry.id} does not state what its projection compares`);
    }
    if (entry.storeTables.length === 0 && entry.dimensions.includes("store")) {
      failures.push(`scenario ${entry.id} declares the store dimension and no tables`);
    }
    const skipped = entry.normalisation?.skip ?? [];
    if (skipped.length > 0 && (entry.normalisation?.why ?? "").trim().length < 60) {
      failures.push(
        `${entry.id} switches off ${skipped.join(", ")} without saying why; a normaliser turned off in silence is a ` +
          "dimension quietly stopped measuring",
      );
    }
    for (const approval of entry.approvedDifferences ?? []) {
      if (typeof approval.rationale !== "string" || approval.rationale.trim().length < 30) {
        failures.push(`${entry.id} approves ${approval.code} with no rationale`);
      }
      if (!/^WIN-\d+$/u.test(approval.issue ?? "")) failures.push(`${entry.id} approves ${approval.code} with no issue`);
    }
  }

  const provers = new Map();
  for (const seed of seeds) {
    if (!ids.has(seed.scenario)) failures.push(`seed ${seed.id} names scenario ${seed.scenario}, which is not registered`);
    if ((seed.proves ?? []).length === 0) {
      failures.push(`seed ${seed.id} proves no dimension; it could be deleted with the sensitivity phase staying green`);
    }
    for (const dimension of seed.proves ?? []) {
      if (provers.has(dimension)) {
        failures.push(`dimensions may have exactly one designated prover; ${dimension} is claimed by ${provers.get(dimension)} and ${seed.id}`);
      }
      provers.set(dimension, seed.id);
    }
  }
  for (const dimension of transportDimensions(registry)) {
    if (!provers.has(dimension)) {
      failures.push(
        `dimension ${dimension} is declared by a transport scenario and no seed is designated to prove it can fail; ` +
          "a dimension nobody has watched go red is a dimension comparing a constant",
      );
    }
  }
  return failures;
}
