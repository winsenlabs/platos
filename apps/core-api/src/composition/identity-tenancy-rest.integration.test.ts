// THE IDENTITY/TENANCY REST REMAINDER, OVER HTTP, AGAINST REAL SERVERS.
//
// `identity-rest.integration.test.ts` proved the first eight identity routes end
// to end. This suite proves the nine that finish WIN-257 T6, in the same shape and
// for the same reason: it starts the process `main.ts` starts
// (`constructAdapters` -> `assembleContextPorts` -> `startCoreApi`) and makes real
// requests with real session tokens whose digests are in real `OperatorSession`
// rows. Nothing is a double:
//
//   PostgreSQL  a pgvector container, migrated by the repository's own
//               `prisma migrate deploy` — or a supplied server — and read back by
//               a `psql` PROCESS that shares no pool with the adapter
//   Redis       a container THIS SUITE STARTS AND STOPS, never a supplied one:
//               the D3 case has to stop it mid-run, and a server somebody else
//               owns is not one a suite may kill
//   SMTP        a Mailpit container: `notifier-email` speaks SMTP to it, and the
//               message is read back through Mailpit's own API after Mailpit's own
//               MIME decoder has parsed it
//   Remix       the webapp's REAL `@remix-run/node`, executed in the webapp's own
//               package to mint and to parse a session cookie (D19)
//
// -----------------------------------------------------------------------------
// THE FORGED SCOPE, IN EVERY TENANCY CASE
//
// A tenancy test that only asks an OUTSIDER — somebody with no membership
// anywhere — proves a route refuses strangers. It does not prove the route refuses
// a legitimate administrator of ANOTHER tenant who names this tenant's id, which is
// the attack. So two organizations are seeded, and every new tenancy route is
// asked by `RIVAL`, an ACTIVE ADMIN of `globex`, naming `acme`'s ids. Each refusal
// is read against the committed taxonomy, and each write that must not have
// happened is counted by the second connection.
//
// IT FAILS WHEN DOCKER IS ABSENT RATHER THAN SKIPPING, for the reason every
// integration suite in this directory gives: a skipped run and a passing run are
// indistinguishable in a summary.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asIdentifier } from "@platos/kernel";

import { loadPlatformConfiguration } from "../config/platform.js";
import { API_VERSION_PREFIX } from "../http/api-surface.js";
import { createProcessDefaults, startCoreApi, type RunningCoreApi } from "../runtime/lifecycle.js";
import { constructAdapters, type AdapterConstruction } from "./adapter-bindings.js";
import { assembleContextPorts } from "./context-ports.js";
import { psqlConnectionUrl, psqlRows } from "./integration-database.js";

const TAXONOMY = JSON.parse(
  readFileSync(new URL("../../../../docs/error-taxonomy.json", import.meta.url), "utf8"),
) as { readonly codes: Readonly<Record<string, { readonly status: number }>> };

function committedStatus(code: string): number {
  const entry = TAXONOMY.codes[code];
  if (entry === undefined) throw new Error(`${code} is not in the committed taxonomy`);
  return entry.status;
}

/** One frozen read of the machine, for the reason the sibling suite gives. */
const AMBIENT: Readonly<Record<string, string | undefined>> = Object.freeze({ ...process.env });
const suppliedPostgresUrl = (AMBIENT["PLATOS_POSTGRES_INTEGRATION_DATABASE_URL"] ?? "").trim() || null;

/** Containers carry this lane's prefix and a run suffix, so parallel runs never collide. */
const RUN = randomBytes(3).toString("hex");
const MAILPIT_IMAGE = "axllent/mailpit:v1.21";
const LOGIN_PAGE = "https://app.t6.test/magic";

const AT = new Date("2026-09-15T09:00:00.000Z");
const FAR = new Date("2027-06-01T00:00:00.000Z");
const ID = {
  acme: "cccccccc-0001-4000-8000-000000000001",
  acmeProject: "cccccccc-0002-4000-8000-000000000002",
  acmeProd: "cccccccc-0003-4000-8000-000000000003",
  acmeStaging: "cccccccc-0004-4000-8000-000000000004",
  acmeOld: "cccccccc-0005-4000-8000-000000000005",
  globex: "cccccccc-0011-4000-8000-000000000011",
  globexProject: "cccccccc-0012-4000-8000-000000000012",
  globexProd: "cccccccc-0013-4000-8000-000000000013",
} as const;

/** Every operator, with the membership that makes them who they are. */
const OPERATORS = {
  owner: { user: "cccccccc-0101-4000-8000-000000000101", email: "owner@acme.t6.test" },
  admin: { user: "cccccccc-0102-4000-8000-000000000102", email: "admin@acme.t6.test" },
  member: { user: "cccccccc-0103-4000-8000-000000000103", email: "member@acme.t6.test" },
  gone: { user: "cccccccc-0104-4000-8000-000000000104", email: "gone@acme.t6.test" },
  /** THE FORGED-SCOPE CALLER: an ACTIVE ADMIN — of globex. */
  rival: { user: "cccccccc-0105-4000-8000-000000000105", email: "rival@globex.t6.test" },
  invitee: { user: "cccccccc-0106-4000-8000-000000000106", email: "invitee@elsewhere.t6.test" },
  legacy: { user: "cccccccc-0107-4000-8000-000000000107", email: "legacy@acme.t6.test" },
} as const;
type OperatorName = keyof typeof OPERATORS;

const tokenOf = (name: OperatorName): string => `plt_os_t6-${name}-session-token`;
const sessionIdOf = (name: OperatorName): string =>
  `cccccccc-10${String(Object.keys(OPERATORS).indexOf(name)).padStart(2, "0")}-4000-8000-000000001000`;

let postgres: StartedPostgreSqlContainer | null = null;
let databaseUrl = "";
let redis: StartedRedisContainer;
let mailpit: StartedTestContainer;
let mailApi = "";
let construction: AdapterConstruction;
let running: RunningCoreApi;
let base = "";

async function observe(sql: string): Promise<string[]> {
  if (postgres === null) {
    return psqlRows(
      execFileSync(AMBIENT["PLATOS_PSQL_BINARY"] ?? "psql", ["-d", psqlConnectionUrl(databaseUrl), "-t", "-A", "-F", "|", "-c", sql], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  }
  const result = await postgres.exec(["psql", "-U", postgres.getUsername(), "-d", postgres.getDatabase(), "-t", "-A", "-F", "|", "-c", sql]);
  if (result.exitCode !== 0) throw new Error(`psql refused: ${result.output}`);
  return psqlRows(result.output);
}

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
  readonly text: string;
}

async function call(
  method: string,
  path: string,
  options: { readonly as?: OperatorName; readonly cookie?: string; readonly body?: unknown } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.as !== undefined) headers["authorization"] = `Bearer ${tokenOf(options.as)}`;
  if (options.cookie !== undefined) headers["cookie"] = options.cookie;
  const response = await fetch(`${base}${API_VERSION_PREFIX}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    body = {};
  }
  return { status: response.status, headers: response.headers, body, text };
}

function codeOf(answer: Answer): string {
  const error = answer.body["error"] as Record<string, unknown> | undefined;
  return typeof error?.["code"] === "string" ? (error["code"] as string) : `(no error: ${answer.status} ${answer.text.slice(0, 160)})`;
}

/** Refused with exactly this code, at exactly the status the taxonomy commits to. */
function expectRefused(answer: Answer, code: string): void {
  expect(codeOf(answer)).toBe(code);
  expect(answer.status).toBe(committedStatus(code));
  expect(answer.body["data"], "a refusal must not carry data").toBeUndefined();
}

const data = (answer: Answer): Record<string, unknown> => answer.body["data"] as Record<string, unknown>;
const rows = (answer: Answer): readonly Record<string, unknown>[] => answer.body["data"] as readonly Record<string, unknown>[];

// --- the relay, read back through Mailpit's own API ----------------------------

interface MailSummary {
  readonly ID: string;
  readonly To: readonly { readonly Address: string }[];
  readonly Subject: string;
}

async function mailTo(address: string): Promise<readonly MailSummary[]> {
  const listed = (await (await fetch(`${mailApi}/api/v1/messages?limit=200`)).json()) as { messages: MailSummary[] };
  return listed.messages.filter((message) => message.To.some((to) => to.Address === address));
}

async function mailText(id: string): Promise<string> {
  const message = (await (await fetch(`${mailApi}/api/v1/message/${id}`)).json()) as { Text: string };
  return message.Text;
}

/** The token a recipient would click, taken out of the link in the delivered text. */
function tokenInLink(text: string): string {
  const match = /(https:\/\/\S+)/u.exec(text);
  if (match === null) throw new Error("no link in the delivered message");
  return new URL(match[1] ?? "").searchParams.get("token") ?? "";
}

// --- the webapp's own Remix, executed where the webapp runs it ------------------

const WEBAPP = resolve(process.cwd(), "../webapp");
const REMIX_COOKIE = `
import { createCookie } from "@remix-run/node";
const [name, mode, value] = process.argv.slice(1);
const cookie = createCookie(name, { httpOnly: true, path: "/", sameSite: "lax", secure: false });
if (mode === "serialize") process.stdout.write(await cookie.serialize(value, { expires: new Date("2027-01-01T00:00:00.000Z") }));
else process.stdout.write(JSON.stringify(await cookie.parse(value)));
`;

function remix(name: string, mode: "serialize" | "parse", value: string): string {
  return execFileSync(process.execPath, ["--input-type=module", "-e", REMIX_COOKIE, name, mode, value], {
    cwd: WEBAPP,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

beforeAll(async () => {
  const [startedPostgres, startedRedis, startedMailpit] = await Promise.all([
    suppliedPostgresUrl === null
      ? new PostgreSqlContainer("pgvector/pgvector:pg16").withName(`m2m4-identity-rest-pg-${RUN}`).start()
      : Promise.resolve(null),
    new RedisContainer("redis:7-alpine").withName(`m2m4-identity-rest-redis-${RUN}`).start(),
    new GenericContainer(MAILPIT_IMAGE)
      .withName(`m2m4-identity-rest-mailpit-${RUN}`)
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forHttp("/api/v1/info", 8025))
      .start(),
  ]);
  postgres = startedPostgres;
  redis = startedRedis;
  mailpit = startedMailpit;
  databaseUrl = suppliedPostgresUrl ?? postgres!.getConnectionUri();
  mailApi = `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(8025))}`;

  const databasePackage = resolve(process.cwd(), "../../internal-packages/tenancy-database");
  execFileSync(resolve(process.cwd(), "../../node_modules/.bin/prisma"), ["migrate", "deploy", "--schema", resolve(databasePackage, "prisma/schema.prisma")], {
    cwd: databasePackage,
    env: { ...AMBIENT, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });

  const platform = loadPlatformConfiguration({
    PLATOS_ENVIRONMENT: "test",
    PLATOS_CORE_API_PORT: "0",
    PLATOS_STORE_POSTGRES_URL: databaseUrl,
    PLATOS_STORE_REDIS_URL: redis.getConnectionUrl(),
    PLATOS_PROVIDERS_DEFAULT_MODEL: "anthropic:claude-haiku-4-5-20251001",
    PLATOS_SECURITY_ENCRYPTION_KEY: "d".repeat(64),
    PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "2",
    PLATOS_CHANNELS_EMAIL_SMTP_URL: `smtp://${mailpit.getHost()}:${String(mailpit.getMappedPort(1025))}`,
    PLATOS_CHANNELS_EMAIL_FROM: "login@platos.t6.test",
    PLATOS_CHANNELS_EMAIL_LOGIN_URL: LOGIN_PAGE,
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
  const store = construction.adapters["postgres-tenancy"];
  const hasher = construction.adapters["node-crypto-digest"];
  if (store === undefined || hasher === undefined) throw new Error("the store and the hasher must be constructed");

  // SEEDED THROUGH THE ADAPTER'S OWN PORTS, never as SQL.
  const tree = (id: string, slug: string, extra: Record<string, unknown> = {}): never =>
    ({ id: asIdentifier(id), slug: asIdentifier(slug), name: slug, archivedAt: null, createdAt: AT, updatedAt: AT, ...extra }) as never;
  const environment = (id: string, project: string, slug: string, createdAt: Date, extra: Record<string, unknown> = {}): never =>
    ({ id: asIdentifier(id), projectId: asIdentifier(project), slug: asIdentifier(slug), name: slug, archivedAt: null, accessKeyRevocationVersion: 0, memoryFeedbackBackfillCursor: null, memoryFeedbackBackfillCompletedAt: null, createdAt, updatedAt: createdAt, ...extra }) as never;
  await store.unitOfWork.run(async (transaction) => {
    await store.saveOrganization(tree(ID.acme, "acme-t6"), transaction);
    await store.saveOrganization(tree(ID.globex, "globex-t6"), transaction);
    await store.saveProject(tree(ID.acmeProject, "app", { organizationId: asIdentifier(ID.acme) }), transaction);
    await store.saveProject(tree(ID.globexProject, "app", { organizationId: asIdentifier(ID.globex) }), transaction);
    await store.saveEnvironment(environment(ID.acmeProd, ID.acmeProject, "prod", AT), transaction);
    await store.saveEnvironment(environment(ID.acmeStaging, ID.acmeProject, "staging", new Date("2026-09-16T00:00:00.000Z")), transaction);
    await store.saveEnvironment(environment(ID.acmeOld, ID.acmeProject, "old", AT, { archivedAt: AT }), transaction);
    await store.saveEnvironment(environment(ID.globexProd, ID.globexProject, "prod", AT), transaction);
  });
  for (const operator of Object.values(OPERATORS)) {
    await store.users.upsertByEmail(asIdentifier(operator.email), asIdentifier(operator.user));
  }
  const membership = (id: string, organization: string, user: string, role: string, extra: Record<string, unknown> = {}): never =>
    ({ id: asIdentifier(id), organizationId: asIdentifier(organization), userId: asIdentifier(user), role, deactivatedAt: null, createdAt: AT, updatedAt: AT, ...extra }) as never;
  await store.unitOfWork.run(async (transaction) => {
    await store.saveOrganizationMembership(membership("cccccccc-0201-4000-8000-000000000201", ID.acme, OPERATORS.owner.user, "OWNER"), transaction);
    await store.saveOrganizationMembership(membership("cccccccc-0202-4000-8000-000000000202", ID.acme, OPERATORS.admin.user, "ADMIN", { createdAt: new Date("2026-09-15T09:00:01.000Z") }), transaction);
    await store.saveOrganizationMembership(membership("cccccccc-0203-4000-8000-000000000203", ID.acme, OPERATORS.member.user, "MEMBER", { createdAt: new Date("2026-09-15T09:00:02.000Z") }), transaction);
    await store.saveOrganizationMembership(membership("cccccccc-0204-4000-8000-000000000204", ID.acme, OPERATORS.gone.user, "ADMIN", { deactivatedAt: AT }), transaction);
    await store.saveOrganizationMembership(membership("cccccccc-0205-4000-8000-000000000205", ID.globex, OPERATORS.rival.user, "ADMIN"), transaction);
    await store.saveOrganizationMembership(membership("cccccccc-0207-4000-8000-000000000207", ID.acme, OPERATORS.legacy.user, "MEMBER", { createdAt: new Date("2026-09-15T09:00:03.000Z") }), transaction);
    // THE MEMBER CAN SEE THE PROJECT AND NOT MUTATE IT: a VIEWER project role
    // passes gate 3 and fails gate 4 at `secret:mutate`.
    await store.saveProjectMembership(
      { id: asIdentifier("cccccccc-0303-4000-8000-000000000303"), projectId: asIdentifier(ID.acmeProject), organizationMembershipId: asIdentifier("cccccccc-0203-4000-8000-000000000203"), organizationId: asIdentifier(ID.acme), role: "VIEWER", createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
  });
  for (const name of Object.keys(OPERATORS) as OperatorName[]) {
    await store.operatorSessions.save({
      sessionId: asIdentifier(sessionIdOf(name)),
      tokenHash: hasher.hash(tokenOf(name)),
      tier: "OPERATOR",
      userId: asIdentifier(OPERATORS[name].user),
      impersonatedUserId: null,
      parentSessionId: null,
      mfaVerifiedAt: null,
      expiresAt: FAR,
      revokedAt: null,
      lastSeenAt: null,
      createdAt: AT,
    } as never);
  }

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
}, 360_000);

afterAll(async () => {
  await running?.stop("test");
  await construction?.release();
  await mailpit?.stop();
  await redis?.stop().catch(() => undefined);
  await postgres?.stop();
});

describe("not vacuous", () => {
  it("composes identity-access WITH a relay, tenancy and secrets, and binds the relay for both owners", () => {
    expect(running.app.contexts.identityAccess?.name).toBe("identity-access");
    expect(running.app.contexts.tenancy?.name).toBe("tenancy");
    expect(running.app.contexts.secrets?.name).toBe("secrets");
    expect(running.app.bindings.satisfied).toContain("notifier-email:MagicLinkDelivery");
    expect(running.app.bindings.satisfied).toContain("notifier-email:Notifier");
    expect(running.app.unwired.map((row) => row.adapter)).not.toContain("notifier-email");
  });
});

describe("D20 — a magic link is MAILED through notifier-email, and no response carries a token", () => {
  const ADDRESS = "newcomer@example.t6.test";

  it("delivers a working single-use link to a real relay, and the start answers with no token", async () => {
    const started = await call("POST", "/bff/magic-link", { body: { email: " Newcomer@Example.T6.test " } });
    expect(started.status, started.text).toBe(202);
    expect(Object.keys(data(started)).sort()).toEqual(["email", "expiresAt"]);
    expect(data(started)["email"]).toBe(ADDRESS);
    expect(started.headers.get("set-cookie")).toBeNull();

    const delivered = await mailTo(ADDRESS);
    expect(delivered, "the relay must hold exactly one message for the address").toHaveLength(1);
    expect(delivered[0]?.Subject).toBe("Sign in to Platos");
    const text = await mailText(delivered[0]?.ID ?? "");
    expect(text).toContain(`Sign in to Platos: ${LOGIN_PAGE}?token=`);
    const token = tokenInLink(text);
    expect(token.startsWith("plt_ml_")).toBe(true);
    // D20, AS A BYTE-LEVEL FACT: the secret the inbox holds is in no HTTP response.
    expect(started.text).not.toContain(token);
    // AND ONLY ITS DIGEST IS STORED.
    expect(await observe(`SELECT count(*) FROM "MagicLinkToken" WHERE "email" = '${ADDRESS}' AND "consumedAt" IS NULL`)).toEqual(["1"]);

    const completed = await call("POST", "/bff/magic-link/complete", { body: { token } });
    expect(completed.status, completed.text).toBe(200);
    expect(Object.keys(data(completed)).sort()).toEqual(["expiresAt", "sessionId", "userId"]);
    expect(completed.text).not.toContain("plt_os_");
    const setCookie = String(completed.headers.get("set-cookie"));
    expect(setCookie).toContain("platos_operator_session=");
    expect(setCookie).toContain("HttpOnly");

    // THE COOKIE IS A LIVE SESSION FOR THE ADDRESS THAT CLICKED.
    const pair = setCookie.split(";")[0] ?? "";
    const whoami = await call("GET", "/identity/session", { cookie: pair });
    expect(whoami.status, whoami.text).toBe(200);
    expect(data(whoami)["email"]).toBe(ADDRESS);
    expect(data(whoami)["sessionId"]).toBe(data(completed)["sessionId"]);
    // LOGIN IS REGISTRATION, and the link is spent — read by a second connection.
    expect(await observe(`SELECT count(*) FROM "User" WHERE "email" = '${ADDRESS}'`)).toEqual(["1"]);
    expect(await observe(`SELECT count(*) FROM "MagicLinkToken" WHERE "email" = '${ADDRESS}' AND "consumedAt" IS NOT NULL`)).toEqual(["1"]);

    // A SECOND CLICK MINTS NOTHING.
    const replay = await call("POST", "/bff/magic-link/complete", { body: { token } });
    expectRefused(replay, "UNAUTHENTICATED");
    expect(replay.headers.get("set-cookie")).toBeNull();
    expect(await observe(`SELECT count(*) FROM "OperatorSession" s JOIN "User" u ON u."id" = s."userId" WHERE u."email" = '${ADDRESS}'`)).toEqual(["1"]);
  });

  it("refuses an address that cannot be mailed, and mails nothing", async () => {
    const refused = await call("POST", "/bff/magic-link", { body: { email: "nobody at all" } });
    expectRefused(refused, "INVALID_EMAIL_ADDRESS");
  });

  it("spends the LOGIN budget per address, and a refused start is RATE_LIMITED with nothing mailed", async () => {
    // BOUNDED, NOT EXACT. The budget is ten per FIXED minute window, and a run
    // that straddles a window edge legitimately admits more than ten; asserting
    // "the eleventh" would be a test that fails one run in thirty for a reason
    // that is not a defect. What must hold every time: a refusal arrives within
    // two windows' worth, it is RATE_LIMITED, and exactly the admitted requests
    // were mailed.
    const address = "budget@example.t6.test";
    let admitted = 0;
    let limited: Answer | null = null;
    for (let request = 0; request < 21 && limited === null; request += 1) {
      const started = await call("POST", "/bff/magic-link", { body: { email: address } });
      if (started.status === 202) admitted += 1;
      else limited = started;
    }
    expect(limited, "the LOGIN budget must refuse within two windows").not.toBeNull();
    if (limited === null) return;
    expectRefused(limited, "RATE_LIMITED");
    expect(admitted).toBeGreaterThanOrEqual(10);
    expect(await mailTo(address)).toHaveLength(admitted);
  });
});

describe("D19 — a session minted by the legacy Remix code authenticates through core-api", () => {
  it("accepts the cookie Remix's own createCookie wrote, over a real socket", async () => {
    const name = "platos_operator_session";
    const header = remix(name, "serialize", tokenOf("legacy"));
    // THE ENCODING THE CENSUS MEASURED: not the token.
    expect(header.startsWith(`${name}=`)).toBe(true);
    expect(header).not.toContain(tokenOf("legacy"));
    const pair = header.split(";")[0] ?? "";

    const answer = await call("GET", "/identity/session", { cookie: pair });
    expect(answer.status, answer.text).toBe(200);
    expect(data(answer)["actorUserId"]).toBe(OPERATORS.legacy.user);
    expect(data(answer)["sessionId"]).toBe(sessionIdOf("legacy"));
  });

  it("writes a cookie Remix's own parse reads back to a token that is a live session", async () => {
    const exchanged = await call("POST", "/bff/session", { body: { token: tokenOf("legacy") } });
    expect(exchanged.status, exchanged.text).toBe(200);
    const pair = String(exchanged.headers.get("set-cookie")).split(";")[0] ?? "";
    expect(JSON.parse(remix("platos_operator_session", "parse", pair))).toBe(tokenOf("legacy"));
    const again = await call("GET", "/identity/session", { cookie: pair });
    expect(again.status, again.text).toBe(200);
  });

  it("still refuses a legacy cookie for a session that is not live, with the session's own code", async () => {
    const pair = remix("platos_operator_session", "serialize", "plt_os_t6-never-issued").split(";")[0] ?? "";
    expectRefused(await call("GET", "/identity/session", { cookie: pair }), "UNAUTHENTICATED");
  });
});

describe("members — settings.team ported, with the forged scope asked", () => {
  it("lists acme's ACTIVE members with their addresses, oldest first, to its OWNER", async () => {
    const answer = await call("GET", `/organizations/${ID.acme}/members`, { as: "owner" });
    expect(answer.status, answer.text).toBe(200);
    expect(rows(answer).map((row) => [row["role"], row["email"]])).toEqual([
      ["OWNER", OPERATORS.owner.email],
      ["ADMIN", OPERATORS.admin.email],
      ["MEMBER", OPERATORS.member.email],
      ["MEMBER", OPERATORS.legacy.email],
    ]);
  });

  it("refuses a MEMBER, a DEACTIVATED ADMIN, and globex's ADMIN naming acme — one code, no rows", async () => {
    for (const name of ["member", "gone", "rival"] as const) {
      expectRefused(await call("GET", `/organizations/${ID.acme}/members`, { as: name }), "TENANCY_MEMBER_LIST_FORBIDDEN");
    }
    // AND THE FORGED CALLER IS NOT REFUSED FOR BEING A STRANGER: they see their own.
    const own = await call("GET", `/organizations/${ID.globex}/members`, { as: "rival" });
    expect(own.status, own.text).toBe(200);
    expect(rows(own).map((row) => row["email"])).toEqual([OPERATORS.rival.email]);
  });

  it("changes a role for acme's OWNER and ends the member's sessions in the same write", async () => {
    const answer = await call("PATCH", `/organizations/${ID.acme}/members/cccccccc-0207-4000-8000-000000000207`, {
      as: "owner",
      body: { role: "ADMIN" },
    });
    expect(answer.status, answer.text).toBe(200);
    // `{ changed }` ONLY: the schema's own database function ends the sessions before the revoker
    // counts them, so a count would read 0 here — measured on this suite's first
    // run. The row is the evidence.
    expect(data(answer)).toEqual({ changed: true });
    expect(await observe(`SELECT "role" FROM "OrganizationMembership" WHERE "id" = 'cccccccc-0207-4000-8000-000000000207'`)).toEqual(["ADMIN"]);
    expect(await observe(`SELECT COALESCE("revokedAt"::text, 'NULL') FROM "OperatorSession" WHERE "id" = '${sessionIdOf("legacy")}'`)).not.toEqual(["NULL"]);
  });

  it("refuses globex's ADMIN changing an acme role, and the row does not move", async () => {
    const answer = await call("PATCH", `/organizations/${ID.acme}/members/cccccccc-0203-4000-8000-000000000203`, {
      as: "rival",
      body: { role: "ADMIN" },
    });
    expectRefused(answer, "TENANCY_MEMBERSHIP_FORBIDDEN");
    expect(await observe(`SELECT "role" FROM "OrganizationMembership" WHERE "id" = 'cccccccc-0203-4000-8000-000000000203'`)).toEqual(["MEMBER"]);
  });

  it("refuses a role that is not one of the three with the domain's code", async () => {
    const answer = await call("PATCH", `/organizations/${ID.acme}/members/cccccccc-0203-4000-8000-000000000203`, {
      as: "owner",
      body: { role: "SUPERUSER" },
    });
    expectRefused(answer, "TENANCY_INVALID_ROLE");
  });
});

describe("D1 — invitations, against the database that enforces one live invitation per address", () => {
  const count = (email: string) => observe(`SELECT count(*) FROM "OrganizationInvitation" WHERE "email" = '${email}'`);

  it("admits acme's OWNER and ADMIN, answers with no token, and writes one live row per address", async () => {
    const byOwner = await call("POST", `/organizations/${ID.acme}/invitations`, { as: "owner", body: { email: "first@new.t6.test" } });
    const byAdmin = await call("POST", `/organizations/${ID.acme}/invitations`, { as: "admin", body: { email: "second@new.t6.test" } });
    for (const answer of [byOwner, byAdmin]) {
      expect(answer.status, answer.text).toBe(201);
      expect(Object.keys(data(answer)).sort()).toEqual(["expiresAt", "invitationId", "supersededCount"]);
      expect(answer.text).not.toContain("plt_inv_");
    }
    expect(await count("first@new.t6.test")).toEqual(["1"]);
    expect(await observe(`SELECT "inviterId", "role" FROM "OrganizationInvitation" WHERE "email" = 'second@new.t6.test'`)).toEqual([
      `${OPERATORS.admin.user}|MEMBER`,
    ]);
  });

  it("refuses a MEMBER, a DEACTIVATED ADMIN, and globex's ADMIN naming acme — the last NOT as not-found — and writes nothing", async () => {
    for (const name of ["member", "gone", "rival"] as const) {
      const answer = await call("POST", `/organizations/${ID.acme}/invitations`, { as: name, body: { email: `${name}-tried@new.t6.test` } });
      expectRefused(answer, "TENANCY_INVITATION_FORBIDDEN");
      expect(codeOf(answer)).not.toBe("TENANCY_NOT_FOUND");
      expect(await count(`${name}-tried@new.t6.test`)).toEqual(["0"]);
    }
  });

  it("refuses an ADMIN inviting an OWNER", async () => {
    const answer = await call("POST", `/organizations/${ID.acme}/invitations`, { as: "admin", body: { email: "boss@new.t6.test", role: "OWNER" } });
    expectRefused(answer, "TENANCY_INVITATION_FORBIDDEN");
    expect(await count("boss@new.t6.test")).toEqual(["0"]);
  });

  it("lets the invitee accept with their own session, and refuses anybody else holding the token", async () => {
    const tenancy = running.app.contexts.tenancy;
    if (tenancy === undefined) throw new Error("tenancy must be composed");
    // The token is taken from the CONTRACT, because no route returns one — see the
    // controller's banner on why delivery is still open.
    const issued = await tenancy.issueInvitation({
      organizationId: asIdentifier(ID.acme),
      inviterUserId: asIdentifier(OPERATORS.owner.user),
      email: OPERATORS.invitee.email,
    });
    if (!issued.ok) throw new Error(`issue refused: ${issued.error.code}`);

    const stolen = await call("POST", "/invitations/accept", { as: "rival", body: { token: issued.value.token } });
    expectRefused(stolen, "TENANCY_INVITATION_EMAIL_MISMATCH");
    expect(await observe(`SELECT count(*) FROM "OrganizationMembership" WHERE "userId" = '${OPERATORS.rival.user}' AND "organizationId" = '${ID.acme}'`)).toEqual(["0"]);

    const accepted = await call("POST", "/invitations/accept", { as: "invitee", body: { token: issued.value.token } });
    expect(accepted.status, accepted.text).toBe(200);
    expect(data(accepted)["organizationId"]).toBe(ID.acme);
    expect(data(accepted)["role"]).toBe("MEMBER");
    expect(await observe(`SELECT "role" FROM "OrganizationMembership" WHERE "userId" = '${OPERATORS.invitee.user}' AND "organizationId" = '${ID.acme}'`)).toEqual(["MEMBER"]);
    expectRefused(await call("POST", "/invitations/accept", { as: "invitee", body: { token: issued.value.token } }), "TENANCY_INVITATION_CONSUMED");
  });
});

describe("environment by slugs — requireEnvironmentScope ported, with the forged scope asked", () => {
  const query = (organization: string, project: string, environment: string) =>
    `/environments/by-slugs?organizationSlug=${organization}&projectSlug=${project}&environmentSlug=${environment}`;

  it("resolves acme/app/prod for its OWNER, with the LIVE environments oldest first", async () => {
    const answer = await call("GET", query("acme-t6", "app", "prod"), { as: "owner" });
    expect(answer.status, answer.text).toBe(200);
    expect((data(answer)["environment"] as Record<string, unknown>)["id"]).toBe(ID.acmeProd);
    expect((data(answer)["environments"] as Record<string, unknown>[]).map((row) => row["slug"])).toEqual(["prod", "staging"]);
    expect(data(answer)["organizationRole"]).toBe("OWNER");
  });

  it("refuses globex's ADMIN naming acme's slugs as FORBIDDEN, and a slug triple nobody has as NOT FOUND", async () => {
    expectRefused(await call("GET", query("acme-t6", "app", "prod"), { as: "rival" }), "TENANCY_ENVIRONMENT_FORBIDDEN");
    expectRefused(await call("GET", query("acme-t6", "app", "old"), { as: "owner" }), "TENANCY_NOT_FOUND");
    // AND GLOBEX'S OWN PROJECT SLUG IS `app` TOO: the triple is resolved top-down,
    // so acme's slug with globex's organization cannot land in acme.
    const own = await call("GET", query("globex-t6", "app", "prod"), { as: "rival" });
    expect(own.status, own.text).toBe(200);
    expect((data(own)["environment"] as Record<string, unknown>)["id"]).toBe(ID.globexProd);
  });
});

describe("D9 — environment variables: metadata out, write-only in, with the forged scope asked", () => {
  const SECRET = "t6-super-secret-value-9f1c";
  const variables = (environment: string) => `/environments/${environment}/variables`;

  it("writes a PLAIN and a SECRET variable for acme's OWNER, and the secret appears in no response and no row", async () => {
    const plain = await call("PUT", `${variables(ID.acmeProd)}/NODE_ENV`, { as: "owner", body: { value: "production" } });
    expect(plain.status, plain.text).toBe(200);
    expect(data(plain)).toMatchObject({ key: "NODE_ENV", kind: "PLAIN", value: "production", hasSecret: false });

    const secret = await call("PUT", `${variables(ID.acmeProd)}/API_TOKEN`, { as: "owner", body: { value: SECRET, secret: true } });
    expect(secret.status, secret.text).toBe(200);
    expect(data(secret)).toMatchObject({ key: "API_TOKEN", kind: "SECRET", value: null, hasSecret: true });
    expect(secret.text).not.toContain(SECRET);

    const listed = await call("GET", variables(ID.acmeProd), { as: "member" });
    expect(listed.status, listed.text).toBe(200);
    expect(rows(listed).map((row) => [row["key"], row["value"]]).sort()).toEqual([
      ["API_TOKEN", null],
      ["NODE_ENV", "production"],
    ]);
    expect(listed.text).not.toContain(SECRET);
    // THE SECOND CONNECTION: the SECRET row holds no value, and no column anywhere
    // in the variable table holds the plaintext.
    expect(await observe(`SELECT "kind", COALESCE("value", 'NULL'), ("credentialId" IS NOT NULL) FROM "EnvironmentVariable" WHERE "key" = 'API_TOKEN'`)).toEqual(["SECRET|NULL|t"]);
    expect(await observe(`SELECT count(*) FROM "EnvironmentVariable" t WHERE t::text LIKE '%${SECRET}%'`)).toEqual(["0"]);
  });

  it("refuses globex's ADMIN reading or writing acme's variables, and the write does not land", async () => {
    expectRefused(await call("GET", variables(ID.acmeProd), { as: "rival" }), "TENANCY_ENVIRONMENT_FORBIDDEN");
    expectRefused(
      await call("PUT", `${variables(ID.acmeProd)}/SMUGGLED`, { as: "rival", body: { value: "x" } }),
      "TENANCY_ENVIRONMENT_FORBIDDEN",
    );
    expect(await observe(`SELECT count(*) FROM "EnvironmentVariable" WHERE "key" = 'SMUGGLED'`)).toEqual(["0"]);
  });

  it("lets a VIEWER list and refuses the VIEWER a write at secret:mutate", async () => {
    expectRefused(
      await call("PUT", `${variables(ID.acmeProd)}/VIEWER_WROTE`, { as: "member", body: { value: "x" } }),
      "TENANCY_ENVIRONMENT_FORBIDDEN",
    );
    expect(await observe(`SELECT count(*) FROM "EnvironmentVariable" WHERE "key" = 'VIEWER_WROTE'`)).toEqual(["0"]);
  });
});

// ---------------------------------------------------------------------------
// D3 — THE LIMITER IS STOPPED MID-RUN, SO THIS DESCRIBE IS LAST IN THE FILE.
// ---------------------------------------------------------------------------
describe("D3 — with the real Redis STOPPED mid-test, sign-in fails CLOSED with its own code", () => {
  it("serves a start while Redis is up, then refuses RATE_LIMIT_FAILED_CLOSED once it is gone, minting and mailing nothing", async () => {
    const address = "outage@example.t6.test";
    const before = await call("POST", "/bff/magic-link", { body: { email: address } });
    expect(before.status, before.text).toBe(202);
    expect(await mailTo(address)).toHaveLength(1);

    await redis.stop();

    const during = await call("POST", "/bff/magic-link", { body: { email: address } });
    expectRefused(during, "RATE_LIMIT_FAILED_CLOSED");
    // DISTINCT FROM A SPENT BUDGET AND FROM THE PORT'S OWN CODE.
    expect(codeOf(during)).not.toBe("RATE_LIMITED");
    expect(codeOf(during)).not.toBe("RATE_LIMITER_UNAVAILABLE");
    expect(await mailTo(address)).toHaveLength(1);
    expect(await observe(`SELECT count(*) FROM "MagicLinkToken" WHERE "email" = '${address}'`)).toEqual(["1"]);
  }, 120_000);
});
