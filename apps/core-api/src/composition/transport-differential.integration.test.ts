// WIN-257 / WIN-284 — THE V1 REST TRANSPORT, REPLAYED AGAINST THE WEBAPP IT
// REPLACED.
//
// THIS SUITE CHANGED SHAPE WITH T8, AND THAT WAS THE PLAN ALL ALONG. It used to
// twin-run two live systems: the oracle was the webapp EXECUTED — real Remix
// loaders and actions out of `apps/webapp/app/routes` against a real PostgreSQL,
// driven by `apps/webapp/test/differential-oracle.mts` — and the candidate was
// the composed core-api process. T8 deletes that oracle: `database.server.ts`,
// `projectAccess.server.ts`, the fifteen Prisma operations and the driver itself
// are gone, because a dashboard holding a database credential is the thing the
// cutover removes.
//
// A differential whose oracle has been deleted does not go red. It goes QUIET —
// the scenarios still execute, the candidate still answers, and the comparison
// has nothing to compare against. That is the worst failure a parity harness has,
// because it looks exactly like success. So the oracle was RECORDED AS IT RAN,
// through the normaliser register, with the digest of every source that produced
// it, and `tests/differential-harness/oracle-transcripts.json` is what T8 leaves
// behind. This suite now compares the CANDIDATE against that frozen record,
// through the same `twinRun`, the same comparators and the same approved
// differences that compared it against the live oracle. One comparison engine,
// not two — which is the property that makes the recording worth anything.
//
// WHAT IS REAL HERE.
//
//   REAL  THE CANDIDATE IS THE COMPOSED PROCESS. `constructAdapters` ->
//         `assembleContextPorts` -> `startCoreApi`, the same three calls
//         `main.ts` makes, answering real HTTP with real session cookies over a
//         real PostgreSQL, a real Redis and a real SMTP relay. Nothing about the
//         candidate side is recorded or faked.
//   REAL  THE STORE COMPARISON. After every step the candidate's database is
//         dumped by a `psql` process and the declared tables are compared row for
//         row against the rows the oracle left. That half passes through no
//         projection at all, which is what stands under the projected `schema`
//         dimension.
//   REAL  THE ORACLE'S ANSWERS. They were produced by executing the webapp, once,
//         before it was deleted — not written by hand here. `oracle-transcripts.
//         test.mjs` runs the controls on that artifact on every CI run with no
//         Docker daemon: provenance, every scenario recorded, all four dimensions
//         per step, no credential, and — now that the driver is gone — that the
//         oracle CANNOT COME BACK (`retirementFailures`). A transcript claiming
//         to record something that had been restored is the one state in which
//         believing it would be wrong.
//
// THE SEEDS STILL RUN, AND STILL AGAINST THE RECORD. One designated seed per
// declared dimension, each changing what the CANDIDATE asks, so a divergence is
// attributable to the seed and to nothing else. A harness that compared a live
// system against a frozen file and never watched that comparison go red would be
// asserting a constant.
//
// IT FAILS WHEN DOCKER IS ABSENT rather than skipping, like every suite in this
// directory: a skipped run and a passing run are indistinguishable in a summary.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadPlatformConfiguration } from "../config/platform.js";
import { API_VERSION_PREFIX } from "../http/api-surface.js";
import { createProcessDefaults, startCoreApi, type RunningCoreApi } from "../runtime/lifecycle.js";
import { constructAdapters, type AdapterConstruction } from "./adapter-bindings.js";
import { assembleContextPorts } from "./context-ports.js";
import { sessionTokenFromCookieValue } from "../transports/rest/session-cookie-value.js";

// The harness is plain ESM beside the repository root; this suite imports it the
// way `route-manifest.test.ts` reads the operation manifest — as a sibling
// artifact, never as a package dependency of this deployable.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const HARNESS = "../../../../tests/differential-harness";

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */

const AMBIENT: Readonly<Record<string, string | undefined>> = Object.freeze({ ...process.env });
const RUN = randomBytes(3).toString("hex");
const MAILPIT_IMAGE = "axllent/mailpit:v1.21";
const REPOSITORY_ROOT = resolve(process.cwd(), "../..");

const OPERATOR_EMAIL = "differential-operator@platos.win284.test";
const AT = "2026-09-16T00:00:00.000Z";

/**
 * Seeded identifiers, IDENTICAL to the ones the oracle's database held when the
 * transcript was recorded — which is what makes a difference a system's rather
 * than a fixture's. They are literals for that reason: the oracle's rows are
 * frozen in the artifact and nothing can re-derive them.
 */
const ID = {
  user: "eeeeeeee-0001-4000-8000-000000000001",
  alpha: "eeeeeeee-0011-4000-8000-000000000011",
  beta: "eeeeeeee-0012-4000-8000-000000000012",
  gamma: "eeeeeeee-0013-4000-8000-000000000013",
  alphaMembership: "eeeeeeee-0021-4000-8000-000000000021",
  betaMembership: "eeeeeeee-0022-4000-8000-000000000022",
  alphaProject: "eeeeeeee-0031-4000-8000-000000000031",
  betaProject: "eeeeeeee-0032-4000-8000-000000000032",
  gammaProject: "eeeeeeee-0033-4000-8000-000000000033",
  alphaProd: "eeeeeeee-0041-4000-8000-000000000041",
  betaProd: "eeeeeeee-0042-4000-8000-000000000042",
  gammaProd: "eeeeeeee-0043-4000-8000-000000000043",
  endUserOne: "eeeeeeee-0051-4000-8000-000000000051",
  endUserTwo: "eeeeeeee-0052-4000-8000-000000000052",
  identityOne: "eeeeeeee-0061-4000-8000-000000000061",
  variable: "eeeeeeee-0071-4000-8000-000000000071",
} as const;

/** The four dimensions an observation carries, on the candidate side. */
interface AuthFacts {
  readonly principal: string | null;
  readonly scopes: string[];
  readonly decision: "allow" | "deny";
  readonly reason: string | null;
}

interface Side {
  readonly status: number;
  readonly facts: Record<string, unknown>;
  readonly auth: AuthFacts;
  readonly store: Record<string, unknown[]>;
}

let postgres: StartedPostgreSqlContainer;
let redis: StartedRedisContainer;
let mailpit: StartedTestContainer;
let construction: AdapterConstruction;
let running: RunningCoreApi;
let base = "";
let mailApi = "";
let candidateUrl = "";

let harness: any;
let scenarios: any;
let transcripts: any;
let recorded: Record<
  string,
  {
    status: number;
    facts: Record<string, unknown>;
    auth: AuthFacts;
    store: Record<string, unknown[]>;
    storeIdentity: string;
  }
> = {};
/** One CANDIDATE observation per scenario. The oracle's is in the transcript. */
const observations = new Map<string, Side>();
const seeded = new Map<string, { candidate: Side; scenario: string }>();

// ---------------------------------------------------------------------------
// PostgreSQL, addressed by a psql PROCESS — the same reader for both databases
// ---------------------------------------------------------------------------

async function psql(database: string, sql: string): Promise<string> {
  const result = await postgres.exec([
    "psql", "-X", "-q", "-A", "-t", "--no-psqlrc", "-v", "ON_ERROR_STOP=1",
    "-h", "127.0.0.1", "-U", postgres.getUsername(), "-d", database, "-c", sql,
  ]);
  if (result.exitCode !== 0) throw new Error(`psql refused on ${database}: ${result.output}`);
  return result.output.trim();
}

function urlFor(database: string): string {
  return `postgresql://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${String(postgres.getMappedPort(5432))}/${database}`;
}

/**
 * Every row of every declared table, as JSON, read by a `psql` process.
 *
 * THE SAME MECHANISM THE ORACLE'S ROWS WERE READ BY. When the transcript was
 * recorded both databases were dumped by this same `psql` process, never through
 * a Prisma client: two readers would differ in how they render a timestamp, a
 * numeric and a null, and every one of those differences would read as drift
 * forever, because one side of the comparison can no longer be re-read.
 */
async function dump(database: string, tables: readonly string[]): Promise<Record<string, unknown[]>> {
  const store: Record<string, unknown[]> = {};
  for (const table of tables) {
    const raw = await psql(database, `SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM "${table}" t`);
    store[table] = JSON.parse(raw === "" ? "[]" : raw) as unknown[];
  }
  return store;
}

// ---------------------------------------------------------------------------
// The candidate: real HTTP against the composed process
// ---------------------------------------------------------------------------

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: any;
  readonly text: string;
}

async function call(method: string, path: string, options: { cookie?: string; body?: unknown } = {}): Promise<Answer> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.cookie !== undefined) headers["cookie"] = options.cookie;
  const response = await fetch(`${base}${API_VERSION_PREFIX}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: any = {};
  try {
    body = text === "" ? {} : JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: response.status, headers: response.headers, body, text };
}

function authOf(answer: Answer, principal: string | null): AuthFacts {
  const code = answer.body?.error?.code;
  return {
    principal,
    scopes: [],
    decision: answer.status < 400 ? "allow" : "deny",
    reason: typeof code === "string" ? code : answer.status >= 400 ? `status ${String(answer.status)}` : null,
  };
}

async function mailToken(address: string): Promise<string | null> {
  const listed = (await (await fetch(`${mailApi}/api/v1/messages?limit=200`)).json()) as any;
  const message = (listed.messages ?? []).find((entry: any) =>
    (entry.To ?? []).some((to: any) => String(to.Address ?? "").toLowerCase() === address.toLowerCase()),
  );
  if (message === undefined) return null;
  const full = (await (await fetch(`${mailApi}/api/v1/message/${message.ID}`)).json()) as any;
  const match = /https?:\/\/\S*token=[^\s"'<>]+/u.exec(String(full.Text ?? ""));
  return match === null ? null : new URL(match[0]).searchParams.get("token");
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

function observation(scenarioId: string, value: Side): any {
  return {
    scenario: scenarioId,
    side: "candidate",
    subject: "core-api-rest-candidate",
    storeIdentity: "differential_candidate",
    // Headers are deliberately empty on both sides. See the registry banner: the
    // one header carrying a fact this differential is about is projected into
    // the body as `cookieName`, where it is compared like any other value.
    response: { status: value.status, headers: {}, body: value.facts },
    events: [],
    auth: value.auth,
    sideEffects: [],
    usage: { inputUnits: 0, outputUnits: 0, costMicros: 0, durationMs: 0, measured: [] },
    store: value.store,
  };
}

// ---------------------------------------------------------------------------

const SEED_SQL = (): string => `
INSERT INTO "User" (id, email, "createdAt", "updatedAt") VALUES ('${ID.user}', '${OPERATOR_EMAIL}', '${AT}', '${AT}');
INSERT INTO "Organization" (id, slug, name, "createdAt", "updatedAt") VALUES
  ('${ID.alpha}', 'alpha', 'Alpha', '${AT}', '${AT}'),
  ('${ID.beta}', 'beta', 'Beta', '${AT}', '${AT}'),
  ('${ID.gamma}', 'gamma', 'Gamma', '${AT}', '${AT}');
INSERT INTO "OrganizationMembership" (id, "organizationId", "userId", role, "createdAt", "updatedAt") VALUES
  ('${ID.alphaMembership}', '${ID.alpha}', '${ID.user}', 'OWNER', '${AT}', '${AT}'),
  ('${ID.betaMembership}', '${ID.beta}', '${ID.user}', 'OWNER', '${AT}', '${AT}');
INSERT INTO "Project" (id, "organizationId", slug, name, "createdAt", "updatedAt") VALUES
  ('${ID.alphaProject}', '${ID.alpha}', 'app', 'App', '${AT}', '${AT}'),
  ('${ID.betaProject}', '${ID.beta}', 'site', 'Site', '${AT}', '${AT}'),
  ('${ID.gammaProject}', '${ID.gamma}', 'hidden', 'Hidden', '${AT}', '${AT}');
INSERT INTO "Environment" (id, "projectId", slug, name, "createdAt", "updatedAt") VALUES
  ('${ID.alphaProd}', '${ID.alphaProject}', 'prod', 'Production', '${AT}', '${AT}'),
  ('${ID.betaProd}', '${ID.betaProject}', 'prod', 'Production', '${AT}', '${AT}'),
  ('${ID.gammaProd}', '${ID.gammaProject}', 'prod', 'Production', '${AT}', '${AT}');
INSERT INTO "EndUser" (id, "organizationId", "displayName", "createdAt", "updatedAt") VALUES
  ('${ID.endUserOne}', '${ID.alpha}', 'Ada', '${AT}', '${AT}'),
  ('${ID.endUserTwo}', '${ID.alpha}', 'Grace', '${AT}', '${AT}');
INSERT INTO "EndUserIdentity" (id, "endUserId", "organizationId", issuer, channel, subject, "createdAt", "updatedAt") VALUES
  ('${ID.identityOne}', '${ID.endUserOne}', '${ID.alpha}', 'oidc', 'web', 'ada@example.test', '${AT}', '${AT}');
INSERT INTO "EnvironmentVariable" (id, "environmentId", key, kind, value, version, "createdAt", "updatedAt") VALUES
  ('${ID.variable}', '${ID.alphaProd}', 'SEEDED_PLAIN', 'PLAIN', 'seeded-value', 1, '${AT}', '${AT}');
`;

beforeAll(async () => {
  harness = {
    twinRun: (await import(`${HARNESS}/twin-run.mjs`)).twinRun,
    formatResult: (await import(`${HARNESS}/twin-run.mjs`)).formatResult,
    normalise: (await import(`${HARNESS}/normalisers.mjs`)).normalise,
  };
  scenarios = await import(`${HARNESS}/transport-scenarios.mjs`);
  transcripts = await import(`${HARNESS}/oracle-transcripts.mjs`);
  recorded = transcripts.readTranscripts(REPOSITORY_ROOT).steps ?? {};

  const [startedPostgres, startedRedis, startedMailpit] = await Promise.all([
    new PostgreSqlContainer("pgvector/pgvector:pg16").withName(`m2m4-evidence-registers-differential-pg-${RUN}`).start(),
    new RedisContainer("redis:7-alpine").withName(`m2m4-evidence-registers-differential-redis-${RUN}`).start(),
    new GenericContainer(MAILPIT_IMAGE)
      .withName(`m2m4-evidence-registers-differential-mail-${RUN}`)
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forHttp("/api/v1/info", 8025))
      .start(),
  ]);
  postgres = startedPostgres;
  redis = startedRedis;
  mailpit = startedMailpit;
  mailApi = `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(8025))}`;

  // ONE DATABASE NOW, AND ITS NAME IS PART OF THE COMPARISON. The oracle's was
  // `differential_oracle` and its rows are in the transcript, tagged with that
  // name; `twinRun` refuses two sides reporting the SAME store identity, because
  // one store twin-run against itself compares equal for free. The candidate's
  // stays `differential_candidate`, so that refusal still has something to check.
  await psql(postgres.getDatabase(), `CREATE DATABASE differential_candidate`);
  candidateUrl = urlFor("differential_candidate");

  const databasePackage = resolve(REPOSITORY_ROOT, "internal-packages/tenancy-database");
  execFileSync(
    resolve(REPOSITORY_ROOT, "node_modules/.bin/prisma"),
    ["migrate", "deploy", "--schema", resolve(databasePackage, "prisma/schema.prisma")],
    { cwd: databasePackage, env: { ...AMBIENT, DATABASE_URL: candidateUrl }, stdio: "pipe" },
  );
  // THE SAME SQL THE ORACLE'S DATABASE WAS SEEDED WITH, so the candidate begins
  // from the rows and the identifiers the recording began from. Anything that
  // differs afterwards was produced by a system rather than by a fixture.
  await psql("differential_candidate", SEED_SQL());

  const platform = loadPlatformConfiguration({
    PLATOS_ENVIRONMENT: "test",
    PLATOS_CORE_API_PORT: "0",
    PLATOS_STORE_POSTGRES_URL: candidateUrl,
    PLATOS_STORE_REDIS_URL: redis.getConnectionUrl(),
    PLATOS_PROVIDERS_DEFAULT_MODEL: "anthropic:claude-haiku-4-5-20251001",
    PLATOS_SECURITY_ENCRYPTION_KEY: "e".repeat(64),
    PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "1",
    PLATOS_SECURITY_SESSION_SECRET: "differential-session-secret-0000000001",
    // THE COOKIE NAME IS THE LEGACY ONE, ON PURPOSE. D19 requires a cookie minted
    // by the Remix code to authenticate through core-api, which it cannot do
    // under a different name. Setting it here is the configuration a real
    // cutover must carry, and it makes `cookieName` a fact the two sides can be
    // compared on rather than a known difference nobody records.
    PLATOS_SECURITY_SESSION_COOKIE_NAME: "platos_operator_session",
    PLATOS_SECURITY_SESSION_COOKIE_SECURE: "false",
    PLATOS_CHANNELS_EMAIL_SMTP_URL: `smtp://${mailpit.getHost()}:${String(mailpit.getMappedPort(1025))}`,
    PLATOS_CHANNELS_EMAIL_FROM: "login@platos.win284.test",
    PLATOS_CHANNELS_EMAIL_LOGIN_URL: "https://app.win284.test/magic",
    PLATOS_CHANNELS_EMAIL_REQUIRE_TLS: "false",
  });
  if (!platform.ok) throw new Error(`platform configuration refused: ${JSON.stringify(platform.diagnostics)}`);
  const defaults = createProcessDefaults(platform.value.core);
  construction = constructAdapters({
    stores: platform.value.stores,
    security: platform.value.security,
    providers: platform.value.providers,
    channels: platform.value.channels,
    clock: defaults.clock,
    correlation: null,
  });
  if (construction.faults.length > 0) throw new Error(construction.faults.join("; "));
  const assembly = assembleContextPorts(construction.adapters, defaults);
  running = await startCoreApi({
    configuration: platform.value.core,
    adapters: construction.adapters,
    ports: assembly.ports,
    unwired: construction.unwired,
    clock: defaults.clock,
    ids: defaults.ids,
    logger: defaults.logger,
  });
  base = `http://${running.host}:${String(running.port)}`;

  await drive();
}, 900_000);

afterAll(async () => {
  await running?.stop("test");
  await construction?.release();
  await Promise.all([postgres?.stop(), redis?.stop(), mailpit?.stop()].filter(Boolean) as Promise<unknown>[]);
});

// ---------------------------------------------------------------------------
// The drive: every scenario, both sides, store dumped after each step
// ---------------------------------------------------------------------------

function tablesFor(id: string): readonly string[] {
  const entry = scenarios.TRANSPORT_SCENARIO_REGISTRY.find((row: any) => row.id === id);
  if (entry === undefined) throw new Error(`no transport scenario ${id}`);
  return entry.storeTables;
}

async function put(id: string, candidateSide: Omit<Side, "store">): Promise<void> {
  observations.set(id, { ...candidateSide, store: await dump("differential_candidate", tablesFor(id)) });
}

async function drive(): Promise<void> {
  // 1. The sign-in. The candidate ends holding a live operator session.
  const started = await call("POST", "/bff/magic-link", { body: { email: OPERATOR_EMAIL } });
  expect(started.status, started.text).toBe(202);
  let token: string | null = null;
  for (let attempt = 0; attempt < 60 && token === null; attempt += 1) {
    token = await mailToken(OPERATOR_EMAIL);
    if (token === null) await new Promise((done) => setTimeout(done, 500));
  }
  expect(token, "the magic link never arrived at the relay").not.toBeNull();
  const completed = await call("POST", "/bff/magic-link/complete", { body: { token } });
  expect(completed.status, completed.text).toBe(200);
  const candidateCookie = (completed.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  // THE COOKIE VALUE IS NOT THE TOKEN, AND THAT IS D19 WORKING. `session-cookie-
  // value.ts` writes the legacy Remix dialect — `base64(JSON.stringify(token))`
  // — so a cookie core-api sets is one a Remix loader still in service can read.
  // A suite that percent-decoded and stopped would hand the exchange an
  // unparseable token and read the resulting 401 as a divergence; the first run
  // of this suite did exactly that.
  const candidateToken = sessionTokenFromCookieValue(decodeURIComponent(candidateCookie.split("=").slice(1).join("=")));

  // SYMMETRY WITH HOW THE ORACLE WAS OBSERVED, AND IT IS NOT COSMETIC. The
  // oracle resolved its principal through `optionalOperator`, which authenticates
  // the session — and authentication is what stamps `lastSeenAt`. Reading the
  // candidate's principal out of the completion body instead would leave its
  // session row unstamped and report a `lastSeenAt` difference that only the two
  // DRIVERS created. The recording cannot be re-made, so this asymmetry would be
  // permanent.
  const whoamiAfterLogin = await call("GET", "/identity/session", { cookie: candidateCookie });
  await put("transport-magic-link-login", {
    status: completed.status,
    facts: {
      signedIn: candidateCookie !== "",
      cookieName: candidateCookie.split("=")[0] ?? null,
      redirectTo: null,
    },
    auth: authOf(completed, whoamiAfterLogin.body?.data?.effectiveUserId ?? null),
  });

  // 2. Who is this browser?
  const whoami = await call("GET", "/identity/session", { cookie: candidateCookie });
  await put("transport-identity-session", {
    status: whoami.status,
    facts: { authenticated: whoami.status === 200, email: whoami.body?.data?.email ?? null },
    auth: authOf(whoami, whoami.body?.data?.effectiveUserId ?? null),
  });

  // 3 and 4. What this operator can see.
  const organizations = await call("GET", "/organizations", { cookie: candidateCookie });
  await put("transport-organization-list", {
    status: organizations.status,
    facts: {
      organizations: (organizations.body?.data ?? [])
        .map((row: any) => ({ slug: row.slug, name: row.name }))
        .sort((left: any, right: any) => (left.slug < right.slug ? -1 : 1)),
    },
    auth: authOf(organizations, ID.user),
  });

  const projects = await call("GET", "/projects", { cookie: candidateCookie });
  await put("transport-project-list", {
    status: projects.status,
    facts: {
      projects: (projects.body?.data ?? [])
        .map((row: any) => ({ slug: row.slug, name: row.name }))
        .sort((left: any, right: any) => (left.slug < right.slug ? -1 : 1)),
    },
    auth: authOf(projects, ID.user),
  });

  // 5. The end-user page.
  const endUsers = await call("GET", `/environments/${ID.alphaProd}/end-users`, { cookie: candidateCookie });
  await put("transport-end-user-page", {
    status: endUsers.status,
    facts: {
      endUsers: (endUsers.body?.data ?? []).map((row: any) => ({ displayName: row.displayName })),
      total: endUsers.body?.page?.total ?? null,
    },
    auth: authOf(endUsers, ID.user),
  });

  // 6. The environment scope, from slugs.
  const scope = await call("GET", "/environments/by-slugs?organizationSlug=alpha&projectSlug=app&environmentSlug=prod", {
    cookie: candidateCookie,
  });
  await put("transport-environment-by-slugs", {
    status: scope.status,
    facts: {
      resolved: scope.status < 400,
      organizationRole: scope.body?.data?.organizationRole ?? null,
      projectRole: scope.body?.data?.projectRole ?? null,
    },
    auth: {
      principal: ID.user,
      scopes: typeof scope.body?.data?.organizationRole === "string" ? [scope.body.data.organizationRole] : [],
      decision: scope.status < 400 ? "allow" : "deny",
      reason: typeof scope.body?.error?.code === "string" ? scope.body.error.code : null,
    },
  });

  // 7 and 8. Environment variables: write, then read.
  const write = await call("PUT", `/environments/${ID.alphaProd}/variables/WRITTEN_PLAIN`, {
    cookie: candidateCookie,
    body: { value: "written-value" },
  });
  await put("transport-environment-variable-set", {
    status: write.status,
    facts: { written: write.status < 400 },
    auth: authOf(write, ID.user),
  });

  const listed = await call("GET", `/environments/${ID.alphaProd}/variables`, { cookie: candidateCookie });
  await put("transport-environment-variable-list", {
    status: listed.status,
    facts: {
      variables: (listed.body?.data ?? [])
        .map((row: any) => ({
          key: row.key,
          kind: row.kind,
          plaintextVisible: row.value !== null,
          present: row.value !== null || row.hasSecret === true,
        }))
        .sort((left: any, right: any) => (left.key < right.key ? -1 : 1)),
    },
    auth: authOf(listed, ID.user),
  });

  // 9 and 10. The two creates.
  const organizationCreate = await call("POST", "/organizations", { cookie: candidateCookie, body: { name: "Delta", slug: "delta" } });
  await put("transport-organization-create", {
    status: organizationCreate.status,
    facts: { created: organizationCreate.status < 400, redirectTo: null },
    auth: authOf(organizationCreate, ID.user),
  });

  const projectCreate = await call("POST", "/projects", {
    cookie: candidateCookie,
    body: { organizationId: ID.alpha, name: "Second", slug: "second", environmentName: "Production", environmentSlug: "production" },
  });
  await put("transport-project-create", {
    status: projectCreate.status,
    facts: { created: projectCreate.status < 400, redirectTo: null },
    auth: authOf(projectCreate, ID.user),
  });

  // 11. The exchange.
  const exchange = await call("POST", "/bff/session", { cookie: candidateCookie, body: { token: candidateToken } });
  const exchangedCookie = (exchange.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  await put("transport-session-exchange", {
    status: exchange.status,
    facts: { exchanged: exchange.status < 400, cookieName: exchangedCookie === "" ? null : exchangedCookie.split("=")[0] },
    auth: authOf(exchange, exchange.body?.data?.effectiveUserId ?? null),
  });

  // 12. Sign out, LAST, because it revokes the session everything above used.
  const signOut = await call("DELETE", "/bff/session", { cookie: candidateCookie });
  const after = await call("GET", "/identity/session", { cookie: candidateCookie });
  await put("transport-sign-out", {
    status: signOut.status,
    facts: { endedSession: after.status === 401, cookieCleared: (signOut.headers.get("set-cookie") ?? "") !== "" },
    auth: { principal: ID.user, scopes: [], decision: "allow", reason: null },
  });

  await driveSeeds();
}

/**
 * The sensitivity phase: one designated seed per declared dimension, run against
 * the FROZEN RECORD after the clean pass.
 *
 * Each seed changes what the CANDIDATE asks — the oracle's answers are in the
 * transcript and cannot be changed by anything — so a divergence is attributable
 * to the seed and to nothing else. That is a stronger attribution than the live
 * twin-run had, where a seed could in principle have moved both sides.
 *
 * `candidate-skips-write` FLIPPED DIRECTION, AND THE DIMENSION IT PROVES DID NOT.
 * It used to have the ORACLE write a row the candidate never asked for. Nothing
 * can make the oracle write now, so the candidate writes a row the recording
 * never had. Either way one store holds a row the other does not, which is the
 * fact the `store` dimension exists to catch, and the write is a REAL one through
 * the real route rather than a perturbation of an observation.
 */
async function driveSeeds(): Promise<void> {
  // The clean pass signed the candidate out, so the seeds that need a session
  // use a fresh one. This is the same real sign-in, run again.
  await call("POST", "/bff/magic-link", { body: { email: OPERATOR_EMAIL } });
  let token: string | null = null;
  for (let attempt = 0; attempt < 60 && token === null; attempt += 1) {
    token = await mailToken(OPERATOR_EMAIL);
    if (token === null) await new Promise((done) => setTimeout(done, 500));
  }
  const completed = await call("POST", "/bff/magic-link/complete", { body: { token } });
  const freshCandidateCookie = (completed.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const organizationTables = tablesFor("transport-organization-list");

  // `candidate-anonymous` — status and auth. The recorded oracle answered 200
  // for the signed-in operator; an anonymous candidate answers 401 with no
  // principal.
  {
    const anonymous = await call("GET", "/organizations");
    seeded.set("candidate-anonymous", {
      scenario: "transport-organization-list",
      candidate: {
        status: anonymous.status,
        facts: { organizations: [] },
        auth: authOf(anonymous, null),
        store: await dump("differential_candidate", organizationTables),
      },
    });
  }

  // `candidate-truncated-page` — schema. Same status, same principal, a shorter
  // set, which is exactly the regression a status-only comparison reports as
  // parity.
  {
    const truncated = await call("GET", "/organizations?limit=1", { cookie: freshCandidateCookie });
    seeded.set("candidate-truncated-page", {
      scenario: "transport-organization-list",
      candidate: {
        status: truncated.status,
        facts: {
          organizations: (truncated.body?.data ?? [])
            .map((row: any) => ({ slug: row.slug, name: row.name }))
            .sort((left: any, right: any) => (left.slug < right.slug ? -1 : 1)),
        },
        auth: authOf(truncated, ID.user),
        store: await dump("differential_candidate", organizationTables),
      },
    });
  }

  // `candidate-skips-write` — store. The candidate really writes a variable the
  // recorded oracle never held, so the two stores differ by one row while the
  // reported status is the one each side gave for the request it made.
  {
    const variableTables = tablesFor("transport-environment-variable-set");
    const extra = await call("PUT", `/environments/${ID.alphaProd}/variables/SEED_ONLY_ON_THE_CANDIDATE`, {
      cookie: freshCandidateCookie,
      body: { value: "seed-value" },
    });
    expect(extra.status, extra.text).toBeLessThan(400);
    seeded.set("candidate-skips-write", {
      scenario: "transport-environment-variable-set",
      candidate: {
        // The recorded oracle answered 200 with `{written: true}` for ITS write,
        // so status and facts agree and only the rows differ — which is what
        // makes this seed prove `store` and nothing else.
        status: 200,
        facts: { written: true },
        auth: { principal: ID.user, scopes: [], decision: "allow", reason: null },
        store: await dump("differential_candidate", variableTables),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

describe("the V1 REST transport against the webapp it replaced", () => {
  it("registers a well-formed scenario set with a designated prover for every dimension", () => {
    expect(scenarios.assertTransportRegistryIsWellFormed()).toEqual([]);
  });

  it("drove every registered scenario against the composed process", () => {
    const missing = scenarios.TRANSPORT_SCENARIO_REGISTRY.map((entry: any) => entry.id).filter(
      (id: string) => !observations.has(id),
    );
    expect(missing, "a registered scenario that was never driven would report parity over nothing").toEqual([]);
  });

  it("the oracle is RETIRED and cannot come back, which is what makes the record believable", () => {
    // THE JOIN THE DIGEST RULE USED TO MAKE. While the oracle driver existed, a
    // source that had moved since the recording failed until it was re-recorded.
    // T8 deleted the driver, so there is nothing left to re-record from, and half
    // the pinned sources are files T8 deliberately rewrote. What replaces it is
    // the claim that still matters: `database.server.ts` and
    // `projectAccess.server.ts` are gone and no surviving source imports the
    // canonical client or calls a Prisma delegate. A transcript that recorded an
    // oracle which had come back would be the one artifact in this harness that
    // is worse than absent.
    expect(transcripts.oracleIsLive(REPOSITORY_ROOT)).toBe(false);
    expect(transcripts.retirementFailures(REPOSITORY_ROOT)).toEqual([]);
    const { failures, oracleLive } = transcripts.transcriptFailures(
      REPOSITORY_ROOT,
      transcripts.readTranscripts(REPOSITORY_ROOT),
      scenarios.TRANSPORT_SCENARIO_REGISTRY.map((entry: any) => entry.id),
    );
    expect(oracleLive).toBe(false);
    expect(failures).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // THE REPLAY — the candidate against the frozen record
  // -------------------------------------------------------------------------
  //
  // One case per scenario, so a failure names the flow rather than the suite.
  // The oracle subject is `recordedOracleSubject`, which hands `twinRun` the
  // recorded step as an observation: the same engine, the same comparators and
  // the same approved differences that compared the candidate against the live
  // oracle before T8 deleted it.
  for (const entry of [
    "transport-magic-link-login",
    "transport-identity-session",
    "transport-session-exchange",
    "transport-organization-list",
    "transport-project-list",
    "transport-organization-create",
    "transport-project-create",
    "transport-end-user-page",
    "transport-environment-by-slugs",
    "transport-environment-variable-set",
    "transport-environment-variable-list",
    "transport-sign-out",
  ]) {
    it(`replays ${entry} against the frozen oracle transcript`, async () => {
      const scenario = scenarios.TRANSPORT_SCENARIO_REGISTRY.find((row: any) => row.id === entry);
      const candidate = observations.get(entry);
      expect(candidate, `${entry} was never driven`).toBeDefined();
      expect(
        transcripts.replayFailures({ steps: recorded }, [entry]),
        "a recorded step that carries no store, or no storeIdentity, is not an oracle — it is a souvenir",
      ).toEqual([]);
      const result = await harness.twinRun(
        scenario,
        {
          oracle: transcripts.recordedOracleSubject(recorded, entry),
          candidate: { run: () => observation(entry, candidate!) },
        },
        { skipNormalisers: scenario.normalisation?.skip ?? [] },
      );
      // THE ROWS THAT DIFFERED ARE THE DIAGNOSTIC. `formatResult` names the code
      // and the path; a store divergence whose row content is not printed is a
      // failure nobody can chase without re-running the whole suite by hand.
      const detail = `${harness.formatResult(result)}\n${JSON.stringify(result.divergences ?? [], null, 1).slice(0, 8000)}`;
      expect(detail).toContain("PARITY");
    });
  }

  it("catches every seeded divergence, on the dimension its seed is designated to prove", async () => {
    const report: string[] = [];
    for (const seed of scenarios.TRANSPORT_SEEDS) {
      const pair = seeded.get(seed.id);
      expect(pair, `seed ${seed.id} never ran`).toBeDefined();
      const scenario = scenarios.TRANSPORT_SCENARIO_REGISTRY.find((row: any) => row.id === seed.scenario);
      const result = await harness.twinRun(
        scenario,
        {
          oracle: transcripts.recordedOracleSubject(recorded, seed.scenario),
          candidate: { run: () => observation(seed.scenario, pair!.candidate) },
        },
        { skipNormalisers: scenario.normalisation?.skip ?? [] },
      );
      const moved = new Set<string>((result.divergences ?? []).map((row: any) => row.dimension));
      for (const dimension of seed.proves) {
        expect(
          moved.has(dimension),
          `seed ${seed.id} was designated to move ${dimension} and did not: ${harness.formatResult(result)}`,
        ).toBe(true);
      }
      report.push(`${seed.id}: ${[...moved].sort().join(", ")}`);
    }
    expect(report.length).toBe(scenarios.TRANSPORT_SEEDS.length);
  });

  it("the replay is not vacuous: a candidate that drifts from the frozen record is caught", async () => {
    // THE MUTATION IS PERMANENT AND IN-SUITE. Without it "replays" would be
    // satisfied by a comparison that compares nothing — the exact failure the
    // transcript exists to prevent, reintroduced one level up. The seeds above
    // prove the same thing through real requests; this one proves it on the
    // dimension that passes through no projection, by perturbing the OBSERVATION
    // rather than the request, so a store comparison that had quietly stopped
    // comparing rows is caught even if every route still behaves.
    const id = "transport-environment-variable-set";
    const scenario = scenarios.TRANSPORT_SCENARIO_REGISTRY.find((row: any) => row.id === id);
    const candidate = observations.get(id);
    const live = observation(id, candidate!);
    const table = Object.keys(live.store)[0] ?? "";
    expect(live.store[table]?.length ?? 0, "the mutation needs a row to drop and a row to keep").toBeGreaterThan(1);
    const perturbed = {
      ...live,
      // Drop the row the write was supposed to leave: a candidate that answered
      // 200 and wrote nothing. ONE ROW, NOT THE TABLE — emptying it is refused
      // as VACUOUS by twinRun before any comparison runs, which would let this
      // control pass while proving nothing. `facts` still says {"written": true},
      // which is precisely why recording the store was the load-bearing half.
      store: { ...live.store, [table]: live.store[table].slice(0, -1) },
    };
    const result = await harness.twinRun(
      scenario,
      { oracle: transcripts.recordedOracleSubject(recorded, id), candidate: { run: () => perturbed } },
      { skipNormalisers: scenario.normalisation?.skip ?? [] },
    );
    const moved = new Set<string>((result.divergences ?? []).map((row: any) => row.dimension));
    expect(
      moved.has("store"),
      `a candidate that wrote no row must diverge from the frozen record on store: ${harness.formatResult(result)}`,
    ).toBe(true);
  });

  it("carries no credential in the transcript it replays", () => {
    expect(transcripts.credentialShapedValues(transcripts.readTranscripts(REPOSITORY_ROOT))).toEqual([]);
  });
});
