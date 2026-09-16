// WIN-257 / WIN-284 — THE V1 REST TRANSPORT, TWIN-RUN AGAINST THE WEBAPP IT REPLACES.
//
// `docs/audits/win-284-differential-coverage.json` reported `rest 0/313`, every
// row blocked on WIN-267 with the reason "no V1 REST transport exists at this
// baseline". Eight routes were served when that sentence was last true and
// nineteen are served now, so the sentence had become false and the number it
// justified had become wrong. This suite is what makes it right again.
//
// WHAT IS REAL HERE.
//
//   REAL  ONE PostgreSQL SERVER, TWO DATABASES. The issue asks for the comparison
//         to run "on the same live PostgreSQL"; `twinRun` refuses two sides that
//         report the same store identity, because one store twin-run against
//         itself compares equal for free. Both are true at once with one server
//         and two databases, which is exactly the shape `subjects/postgres-twin.mjs`
//         already uses. Both are built by the repository's own
//         `prisma migrate deploy` over the real tenancy schema and seeded by
//         IDENTICAL SQL, so the two sides start from the same rows with the same
//         identifiers.
//   REAL  THE ORACLE IS THE WEBAPP, EXECUTED. Every oracle answer comes from
//         running a real Remix `loader`/`action` out of `apps/webapp/app/routes`,
//         or a real export of `apps/webapp/app/services/auth.server`, in the
//         webapp's own package where `@remix-run/node`, the generated Prisma
//         client and the `~/*` alias resolve. Nothing here re-implements a Prisma
//         query, a membership rule or a cookie format.
//   REAL  THE CANDIDATE IS THE COMPOSED PROCESS. `constructAdapters` ->
//         `assembleContextPorts` -> `startCoreApi`, the same three calls `main.ts`
//         makes, answering real HTTP with real session cookies over a real Redis
//         and a real SMTP relay.
//   REAL  THE STORE COMPARISON. After every step both databases are dumped by the
//         SAME mechanism and the declared tables are compared row for row. That
//         half passes through no projection at all, which is what stands under
//         the projected `schema` dimension.
//
// AND THE ORACLE IS RECORDED AS IT RUNS. WIN-257 T8 deletes `database.server.ts`
// and the `PlatosAuthService` calls with it. A scenario whose oracle has been
// deleted quietly stops meaning anything, so every live oracle answer is written
// to `tests/differential-harness/oracle-transcripts.json` together with the
// digest of the source files that produced it. While those files exist the
// transcript must match what they answer TODAY — a drifted oracle fails this
// suite rather than being silently re-recorded — and once the cutover removes
// them the transcript is the frozen record of what they answered, which the
// candidate keeps being compared against.
//
// NO TOKEN IS EVER TRANSCRIBED. The recorded facts are booleans, names, slugs and
// seeded identifiers. `Set-Cookie` is used by the run and dropped before the
// transcript is written, because a committed transcript carrying a live session
// credential would be a secret-response defect of exactly the class WIN-259
// counts.
//
// IT FAILS WHEN DOCKER IS ABSENT rather than skipping, like every suite in this
// directory: a skipped run and a passing run are indistinguishable in a summary.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
const TRANSCRIPT_PATH = resolve(REPOSITORY_ROOT, "tests/differential-harness/oracle-transcripts.json");
const RECORDING = (AMBIENT["PLATOS_DIFFERENTIAL_RECORD"] ?? "") === "1";

const OPERATOR_EMAIL = "differential-operator@platos.win284.test";
const AT = "2026-09-16T00:00:00.000Z";

/** Seeded identifiers. IDENTICAL in both databases, so a difference is never a fixture's. */
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

const VISIBLE_SLUGS = ["alpha", "beta", "gamma"] as const;

interface OracleAnswer {
  readonly status: number;
  readonly facts: Record<string, unknown>;
  readonly auth: { principal: string | null; scopes: string[]; decision: "allow" | "deny"; reason: string | null };
  readonly setCookie: string | null;
}

interface Side {
  readonly status: number;
  readonly facts: Record<string, unknown>;
  readonly auth: OracleAnswer["auth"];
  readonly store: Record<string, unknown[]>;
}

let postgres: StartedPostgreSqlContainer;
let redis: StartedRedisContainer;
let mailpit: StartedTestContainer;
let construction: AdapterConstruction;
let running: RunningCoreApi;
let base = "";
let mailApi = "";
let workspace = "";
let oracleUrl = "";
let candidateUrl = "";

let harness: any;
let scenarios: any;
let recorded: Record<
  string,
  {
    status: number;
    facts: Record<string, unknown>;
    auth: OracleAnswer["auth"];
    store: Record<string, unknown[]>;
    storeIdentity: string;
  }
> = {};
const observations = new Map<string, { oracle: Side; candidate: Side }>();
const seeded = new Map<string, { oracle: Side; candidate: Side; scenario: string }>();

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
 * ONE MECHANISM FOR BOTH SIDES. A dump taken through the oracle's Prisma client
 * and a dump taken through `psql` would differ in how they render a timestamp,
 * a numeric and a null — and every one of those differences would read as drift.
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
// The oracle: one child process per step, executed in apps/webapp
// ---------------------------------------------------------------------------

function oracle(step: string, params: Record<string, unknown>): OracleAnswer {
  const requestPath = join(workspace, `oracle-${step}-request.json`);
  const outPath = join(workspace, `oracle-${step}-out.json`);
  writeFileSync(requestPath, JSON.stringify({ step, params }));
  execFileSync(
    resolve(REPOSITORY_ROOT, "apps/webapp/node_modules/.bin/tsx"),
    [resolve(REPOSITORY_ROOT, "apps/webapp/test/differential-oracle.mts"), requestPath, outPath],
    {
      cwd: resolve(REPOSITORY_ROOT, "apps/webapp"),
      env: {
        PATH: AMBIENT["PATH"] ?? "",
        NODE_ENV: "test",
        DATABASE_URL: oracleUrl,
        ENCRYPTION_KEY: "e".repeat(64),
        PLATOS_INTERNAL_AUTH_TOKEN: "differential-internal-token-0001",
        LOGIN_ORIGIN: "http://oracle.differential.test",
        // The one configuration in which the REAL login action runs end to end
        // without an outbound email provider: it issues AND consumes the link
        // itself. Both halves are the oracle's own.
        BACKDOOR_PLATOS_DEV: "1",
        BACKDOOR_PLATOS_DEV_EMAIL: OPERATOR_EMAIL,
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    },
  );
  return JSON.parse(readFileSync(outPath, "utf8")) as OracleAnswer;
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

function authOf(answer: Answer, principal: string | null): OracleAnswer["auth"] {
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

function observation(side: "oracle" | "candidate", scenarioId: string, storeName: string, value: Side): any {
  return {
    scenario: scenarioId,
    side,
    subject: side === "oracle" ? "webapp-prisma-oracle" : "core-api-rest-candidate",
    storeIdentity: storeName,
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
  const transcripts = await import(`${HARNESS}/oracle-transcripts.mjs`);
  recorded = transcripts.readTranscripts(REPOSITORY_ROOT).steps ?? {};

  workspace = mkdtempSync(join(tmpdir(), `m2m4-evidence-registers-differential-${RUN}-`));

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

  await psql(postgres.getDatabase(), `CREATE DATABASE differential_oracle`);
  await psql(postgres.getDatabase(), `CREATE DATABASE differential_candidate`);
  oracleUrl = urlFor("differential_oracle");
  candidateUrl = urlFor("differential_candidate");

  const databasePackage = resolve(REPOSITORY_ROOT, "internal-packages/tenancy-database");
  for (const url of [oracleUrl, candidateUrl]) {
    execFileSync(
      resolve(REPOSITORY_ROOT, "node_modules/.bin/prisma"),
      ["migrate", "deploy", "--schema", resolve(databasePackage, "prisma/schema.prisma")],
      { cwd: databasePackage, env: { ...AMBIENT, DATABASE_URL: url }, stdio: "pipe" },
    );
  }
  // IDENTICAL SQL, so the two sides begin with the same rows and the same
  // identifiers. Anything that differs afterwards was produced by a system.
  await psql("differential_oracle", SEED_SQL());
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

async function put(id: string, oracleSide: Omit<Side, "store">, candidateSide: Omit<Side, "store">): Promise<void> {
  const tables = tablesFor(id);
  observations.set(id, {
    oracle: { ...oracleSide, store: await dump("differential_oracle", tables) },
    candidate: { ...candidateSide, store: await dump("differential_candidate", tables) },
  });
}

async function drive(): Promise<void> {
  // 1. The sign-in. Both sides end holding a live operator session.
  const oracleLogin = oracle("magic-link-login", { email: OPERATOR_EMAIL });
  const oracleCookie = (oracleLogin.setCookie ?? "").split(";")[0] ?? "";

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

  // SYMMETRY, AND IT IS NOT COSMETIC. The oracle resolves its principal through
  // `optionalOperator`, which authenticates the session — and authentication is
  // what stamps `lastSeenAt`. Reading the candidate's principal out of the
  // completion body instead would leave its session row unstamped and report a
  // `lastSeenAt` difference that only the two DRIVERS created. Both sides now
  // ask the same question the same way.
  const whoamiAfterLogin = await call("GET", "/identity/session", { cookie: candidateCookie });
  await put(
    "transport-magic-link-login",
    { status: oracleLogin.status, facts: oracleLogin.facts, auth: oracleLogin.auth },
    {
      status: completed.status,
      facts: {
        signedIn: candidateCookie !== "",
        cookieName: candidateCookie.split("=")[0] ?? null,
        redirectTo: null,
      },
      auth: authOf(completed, whoamiAfterLogin.body?.data?.effectiveUserId ?? null),
    },
  );

  // 2. Who is this browser?
  const oracleWhoami = oracle("identity-session", { cookie: oracleCookie });
  const whoami = await call("GET", "/identity/session", { cookie: candidateCookie });
  await put(
    "transport-identity-session",
    { status: oracleWhoami.status, facts: oracleWhoami.facts, auth: oracleWhoami.auth },
    {
      status: whoami.status,
      facts: { authenticated: whoami.status === 200, email: whoami.body?.data?.email ?? null },
      auth: authOf(whoami, whoami.body?.data?.effectiveUserId ?? null),
    },
  );

  // 3 and 4. What this operator can see.
  const oracleOrganizations = oracle("organization-list", { cookie: oracleCookie, slugs: [...VISIBLE_SLUGS] });
  const organizations = await call("GET", "/organizations", { cookie: candidateCookie });
  await put(
    "transport-organization-list",
    { status: oracleOrganizations.status, facts: oracleOrganizations.facts, auth: oracleOrganizations.auth },
    {
      status: organizations.status,
      facts: {
        organizations: (organizations.body?.data ?? [])
          .map((row: any) => ({ slug: row.slug, name: row.name }))
          .sort((left: any, right: any) => (left.slug < right.slug ? -1 : 1)),
      },
      auth: authOf(organizations, ID.user),
    },
  );

  const oracleProjects = oracle("project-list", { cookie: oracleCookie, slugs: [...VISIBLE_SLUGS] });
  const projects = await call("GET", "/projects", { cookie: candidateCookie });
  await put(
    "transport-project-list",
    { status: oracleProjects.status, facts: oracleProjects.facts, auth: oracleProjects.auth },
    {
      status: projects.status,
      facts: {
        projects: (projects.body?.data ?? [])
          .map((row: any) => ({ slug: row.slug, name: row.name }))
          .sort((left: any, right: any) => (left.slug < right.slug ? -1 : 1)),
      },
      auth: authOf(projects, ID.user),
    },
  );

  // 5. The end-user page.
  const oracleEndUsers = oracle("end-user-page", {
    cookie: oracleCookie,
    organizationSlug: "alpha",
    projectSlug: "app",
    environmentSlug: "prod",
  });
  const endUsers = await call("GET", `/environments/${ID.alphaProd}/end-users`, { cookie: candidateCookie });
  await put(
    "transport-end-user-page",
    { status: oracleEndUsers.status, facts: oracleEndUsers.facts, auth: oracleEndUsers.auth },
    {
      status: endUsers.status,
      facts: {
        endUsers: (endUsers.body?.data ?? []).map((row: any) => ({ displayName: row.displayName })),
        total: endUsers.body?.page?.total ?? null,
      },
      auth: authOf(endUsers, ID.user),
    },
  );

  // 6. The environment scope, from slugs.
  const oracleScope = oracle("environment-by-slugs", {
    cookie: oracleCookie,
    organizationSlug: "alpha",
    projectSlug: "app",
    environmentSlug: "prod",
  });
  const scope = await call("GET", "/environments/by-slugs?organizationSlug=alpha&projectSlug=app&environmentSlug=prod", {
    cookie: candidateCookie,
  });
  await put(
    "transport-environment-by-slugs",
    { status: oracleScope.status, facts: oracleScope.facts, auth: oracleScope.auth },
    {
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
    },
  );

  // 7 and 8. Environment variables: write, then read.
  const oracleWrite = oracle("environment-variable-set", {
    cookie: oracleCookie,
    organizationSlug: "alpha",
    projectSlug: "app",
    environmentSlug: "prod",
    key: "WRITTEN_PLAIN",
    value: "written-value",
  });
  const write = await call("PUT", `/environments/${ID.alphaProd}/variables/WRITTEN_PLAIN`, {
    cookie: candidateCookie,
    body: { value: "written-value" },
  });
  await put(
    "transport-environment-variable-set",
    { status: oracleWrite.status, facts: oracleWrite.facts, auth: oracleWrite.auth },
    { status: write.status, facts: { written: write.status < 400 }, auth: authOf(write, ID.user) },
  );

  const oracleList = oracle("environment-variable-list", {
    cookie: oracleCookie,
    organizationSlug: "alpha",
    projectSlug: "app",
    environmentSlug: "prod",
  });
  const listed = await call("GET", `/environments/${ID.alphaProd}/variables`, { cookie: candidateCookie });
  await put(
    "transport-environment-variable-list",
    { status: oracleList.status, facts: oracleList.facts, auth: oracleList.auth },
    {
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
    },
  );

  // 9 and 10. The two creates.
  const oracleOrganizationCreate = oracle("organization-create", { cookie: oracleCookie, name: "Delta", slug: "delta" });
  const organizationCreate = await call("POST", "/organizations", { cookie: candidateCookie, body: { name: "Delta", slug: "delta" } });
  await put(
    "transport-organization-create",
    { status: oracleOrganizationCreate.status, facts: oracleOrganizationCreate.facts, auth: oracleOrganizationCreate.auth },
    {
      status: organizationCreate.status,
      facts: { created: organizationCreate.status < 400, redirectTo: null },
      auth: authOf(organizationCreate, ID.user),
    },
  );

  const oracleProjectCreate = oracle("project-create", {
    cookie: oracleCookie,
    organizationSlug: "alpha",
    name: "Second",
    slug: "second",
    environment: "Production",
  });
  const projectCreate = await call("POST", "/projects", {
    cookie: candidateCookie,
    body: { organizationId: ID.alpha, name: "Second", slug: "second", environmentName: "Production", environmentSlug: "production" },
  });
  await put(
    "transport-project-create",
    { status: oracleProjectCreate.status, facts: oracleProjectCreate.facts, auth: oracleProjectCreate.auth },
    {
      status: projectCreate.status,
      facts: { created: projectCreate.status < 400, redirectTo: null },
      auth: authOf(projectCreate, ID.user),
    },
  );

  // 11. The exchange.
  const oracleExchange = oracle("session-exchange", { cookie: oracleCookie, expiresAt: "2027-01-01T00:00:00.000Z" });
  const exchange = await call("POST", "/bff/session", { cookie: candidateCookie, body: { token: candidateToken } });
  const exchangedCookie = (exchange.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  await put(
    "transport-session-exchange",
    { status: oracleExchange.status, facts: oracleExchange.facts, auth: oracleExchange.auth },
    {
      status: exchange.status,
      facts: { exchanged: exchange.status < 400, cookieName: exchangedCookie === "" ? null : exchangedCookie.split("=")[0] },
      auth: authOf(exchange, exchange.body?.data?.effectiveUserId ?? null),
    },
  );

  // 12. Sign out, LAST, because it revokes the session both sides have been using.
  const oracleSignOut = oracle("sign-out", { cookie: oracleCookie });
  const signOut = await call("DELETE", "/bff/session", { cookie: candidateCookie });
  const after = await call("GET", "/identity/session", { cookie: candidateCookie });
  await put(
    "transport-sign-out",
    { status: oracleSignOut.status, facts: oracleSignOut.facts, auth: oracleSignOut.auth },
    {
      status: signOut.status,
      facts: { endedSession: after.status === 401, cookieCleared: (signOut.headers.get("set-cookie") ?? "") !== "" },
      auth: { principal: ID.user, scopes: [], decision: "allow", reason: null },
    },
  );

  await driveSeeds(oracleCookie, candidateCookie);
}

/**
 * The sensitivity phase: one designated seed per declared dimension, run against
 * the same two databases after the clean pass.
 *
 * Each seed changes what the CANDIDATE asks, never what the oracle does, so any
 * divergence is attributable to the seed and to nothing else.
 */
async function driveSeeds(oracleCookie: string, candidateCookie: string): Promise<void> {
  // The clean pass signed both sides out, so the seeds that need a session use a
  // fresh one. This is the same real sign-in, run again.
  const oracleLogin = oracle("magic-link-login", { email: OPERATOR_EMAIL });
  const freshOracleCookie = (oracleLogin.setCookie ?? "").split(";")[0] ?? oracleCookie;
  await call("POST", "/bff/magic-link", { body: { email: OPERATOR_EMAIL } });
  let token: string | null = null;
  for (let attempt = 0; attempt < 60 && token === null; attempt += 1) {
    token = await mailToken(OPERATOR_EMAIL);
    if (token === null) await new Promise((done) => setTimeout(done, 500));
  }
  const completed = await call("POST", "/bff/magic-link/complete", { body: { token } });
  const freshCandidateCookie = (completed.headers.get("set-cookie") ?? "").split(";")[0] ?? candidateCookie;

  const organizationTables = tablesFor("transport-organization-list");

  // `candidate-anonymous` — status and auth.
  {
    const oracleAnswer = oracle("organization-list", { cookie: freshOracleCookie, slugs: [...VISIBLE_SLUGS] });
    const anonymous = await call("GET", "/organizations");
    seeded.set("candidate-anonymous", {
      scenario: "transport-organization-list",
      oracle: {
        status: oracleAnswer.status,
        facts: oracleAnswer.facts,
        auth: oracleAnswer.auth,
        store: await dump("differential_oracle", organizationTables),
      },
      candidate: {
        status: anonymous.status,
        facts: { organizations: [] },
        auth: authOf(anonymous, null),
        store: await dump("differential_candidate", organizationTables),
      },
    });
  }

  // `candidate-truncated-page` — schema.
  {
    const oracleAnswer = oracle("organization-list", { cookie: freshOracleCookie, slugs: [...VISIBLE_SLUGS] });
    const truncated = await call("GET", "/organizations?limit=1", { cookie: freshCandidateCookie });
    seeded.set("candidate-truncated-page", {
      scenario: "transport-organization-list",
      oracle: {
        status: oracleAnswer.status,
        facts: oracleAnswer.facts,
        auth: oracleAnswer.auth,
        store: await dump("differential_oracle", organizationTables),
      },
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

  // `candidate-skips-write` — store. The oracle writes a variable the candidate
  // never asks for, so one database is short a row while both sides report the
  // status of the request they actually made.
  {
    const variableTables = tablesFor("transport-environment-variable-set");
    const oracleAnswer = oracle("environment-variable-set", {
      cookie: freshOracleCookie,
      organizationSlug: "alpha",
      projectSlug: "app",
      environmentSlug: "prod",
      key: "SEED_ONLY_ON_THE_ORACLE",
      value: "seed-value",
    });
    seeded.set("candidate-skips-write", {
      scenario: "transport-environment-variable-set",
      oracle: {
        status: oracleAnswer.status,
        facts: oracleAnswer.facts,
        auth: oracleAnswer.auth,
        store: await dump("differential_oracle", variableTables),
      },
      candidate: {
        status: oracleAnswer.status,
        facts: { written: true },
        auth: oracleAnswer.auth,
        store: await dump("differential_candidate", variableTables),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

describe("the V1 REST transport against the webapp it replaces", () => {
  it("registers a well-formed scenario set with a designated prover for every dimension", () => {
    expect(scenarios.assertTransportRegistryIsWellFormed()).toEqual([]);
  });

  it("drove every registered scenario on both sides", () => {
    const missing = scenarios.TRANSPORT_SCENARIO_REGISTRY.map((entry: any) => entry.id).filter(
      (id: string) => !observations.has(id),
    );
    expect(missing, "a registered scenario that was never driven would report parity over nothing").toEqual([]);
  });

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
    it(`reaches parity on ${entry}`, async () => {
      const scenario = scenarios.TRANSPORT_SCENARIO_REGISTRY.find((row: any) => row.id === entry);
      const pair = observations.get(entry);
      expect(pair, `${entry} was never driven`).toBeDefined();
      const result = await harness.twinRun(
        scenario,
        {
          oracle: { run: () => observation("oracle", entry, "differential_oracle", pair!.oracle) },
          candidate: { run: () => observation("candidate", entry, "differential_candidate", pair!.candidate) },
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
          oracle: { run: () => observation("oracle", seed.scenario, "differential_oracle", pair!.oracle) },
          candidate: { run: () => observation("candidate", seed.scenario, "differential_candidate", pair!.candidate) },
        },
        { skipNormalisers: scenario.normalisation?.skip ?? [] },
      );
      const moved = new Set<string>((result.divergences ?? []).map((row: any) => row.dimension));
      for (const dimension of seed.proves) {
        expect(moved.has(dimension), `seed ${seed.id} was designated to move ${dimension} and did not: ${harness.formatResult(result)}`).toBe(true);
      }
      report.push(`${seed.id}: ${[...moved].sort().join(", ")}`);
    }
    expect(report.length).toBe(scenarios.TRANSPORT_SEEDS.length);
  });

  it("matches the recorded oracle transcript, or records it when asked to", async () => {
    const transcripts = await import(`${HARNESS}/oracle-transcripts.mjs`);
    const live: Record<string, unknown> = {};
    for (const [id, pair] of observations) {
      // RECORDED THROUGH THE NORMALISERS, and all four dimensions of them. The
      // first version wrote {status, facts, auth} only, which left the `store`
      // half — the one that passes through no projection, and the only half that
      // says anything at all about `transport-environment-variable-set` — out of
      // the record the cutover leaves behind. Normalising before writing is what
      // makes the step replayable by the same engine AND what keeps a session
      // tokenHash out of the artifact: `digest-ordinal` has already replaced it.
      const scenario = scenarios.TRANSPORT_SCENARIO_REGISTRY.find((row: any) => row.id === id);
      const normalised = harness.normalise(observation("oracle", id, "differential_oracle", pair.oracle), {
        unorderedCollections: scenario?.unorderedCollections ?? [],
        skip: scenario?.normalisation?.skip ?? [],
      });
      live[id] = {
        status: normalised.response.status,
        facts: normalised.response.body,
        auth: normalised.auth,
        store: normalised.store,
        storeIdentity: normalised.storeIdentity,
      };
    }
    if (RECORDING) {
      transcripts.writeTranscripts(REPOSITORY_ROOT, live);
      return;
    }
    const drift = transcripts.compareTranscripts(recorded, live);
    expect(
      drift,
      "the live oracle no longer answers what the committed transcript recorded. Either the webapp changed — in " +
        "which case the transcript must be re-recorded with PLATOS_DIFFERENTIAL_RECORD=1 and the change reviewed — " +
        "or the differential has drifted.",
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // THE REPLAY. This is the case WIN-257's write-up claimed and did not have.
  // -------------------------------------------------------------------------
  //
  // The case above compares the RECORDING against the LIVE oracle: a drift
  // detector, and one that stops working the moment T8 deletes the sources. This
  // one compares the CANDIDATE against the FROZEN RECORD, which is what T8 leaves
  // behind — the same `twinRun`, the same comparators, the same approved
  // differences, with the recorded step handed back as the oracle subject.
  //
  // It is not redundant with `reaches parity on …` today and it is the only
  // comparison left tomorrow. Today it is the proof that the record is
  // SUFFICIENT: if a scenario's meaning does not survive being written down and
  // read back, that is visible now, while the oracle still exists to re-record
  // from, rather than on the first run after the cutover.
  it("replays the CANDIDATE against the frozen transcript, which is the oracle the cutover leaves behind", async () => {
    if (RECORDING) return;
    const transcripts = await import(`${HARNESS}/oracle-transcripts.mjs`);
    const ids = [...observations.keys()].sort();
    expect(
      transcripts.replayFailures({ steps: recorded }, ids),
      "a recorded step that carries no store, or no storeIdentity, is not an oracle — it is a souvenir",
    ).toEqual([]);

    const report: string[] = [];
    for (const id of ids) {
      const scenario = scenarios.TRANSPORT_SCENARIO_REGISTRY.find((row: any) => row.id === id);
      const pair = observations.get(id);
      const result = await harness.twinRun(
        scenario,
        {
          oracle: transcripts.recordedOracleSubject(recorded, id),
          candidate: { run: () => observation("candidate", id, "differential_candidate", pair!.candidate) },
        },
        { skipNormalisers: scenario.normalisation?.skip ?? [] },
      );
      const detail = `${harness.formatResult(result)}\n${JSON.stringify(result.divergences ?? [], null, 1).slice(0, 4000)}`;
      expect(detail, `${id} does not replay against its recorded oracle`).toContain("PARITY");
      report.push(id);
    }
    expect(report.length, "every driven scenario must replay, or the record is partial").toBe(ids.length);
  });

  it("the replay is not vacuous: a candidate that drifts from the frozen record is caught", async () => {
    if (RECORDING) return;
    const transcripts = await import(`${HARNESS}/oracle-transcripts.mjs`);
    // THE MUTATION IS PERMANENT AND IN-SUITE. Without it "replays" would be
    // satisfied by a comparison that compares nothing — the exact failure the
    // transcript exists to prevent, reintroduced one level up.
    const id = "transport-environment-variable-set";
    const scenario = scenarios.TRANSPORT_SCENARIO_REGISTRY.find((row: any) => row.id === id);
    const pair = observations.get(id);
    const live = observation("candidate", id, "differential_candidate", pair!.candidate);
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

  it("carries no credential in the transcript it commits", async () => {
    const transcripts = await import(`${HARNESS}/oracle-transcripts.mjs`);
    expect(transcripts.credentialShapedValues(transcripts.readTranscripts(REPOSITORY_ROOT))).toEqual([]);
  });
});
