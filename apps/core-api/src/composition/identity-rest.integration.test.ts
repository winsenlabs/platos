// THE IDENTITY AND TENANCY REST SURFACE, OVER HTTP, AGAINST A REAL DATABASE.
//
// ---------------------------------------------------------------------------
// WHY THIS SUITE EXISTS
//
// `composition/operator-authentication.integration.test.ts` proved, for the first
// time in four tranches, that `apps/core-api` can authenticate an operator
// through a context it composed. It proved it AT THE CONTRACT EDGE: it calls
// `identityAccess.authenticateOperator(...)` directly. Everything between that
// call and a socket — the version prefix, the controller, the guard that finds a
// cookie, the exception filter, the envelope — was still unproven, and three
// tranches of REST work have been refused on exactly that gap.
//
// So this suite starts the process `main.ts` starts, over the SAME composition
// (`constructAdapters` -> `assembleContextPorts` -> `startCoreApi`), binds a real
// port, and makes real HTTP requests with a real session token whose digest is in
// a real `OperatorSession` row. Nothing here is a double: the hasher is
// `node-crypto-digest`, the store is `postgres-tenancy` over PostgreSQL 16, the
// limiter is Redis, and rows are read back by a `psql` process INSIDE the
// container, which shares no pool, driver or transaction with the adapter.
//
// ---------------------------------------------------------------------------
// THE FOUR REFUSALS, AND THE ONE THAT IS NOT HERE
//
// M0.4 §2 and `error-taxonomy.mjs` both turn on one property: two guards that
// return the same code cannot be told apart. This surface answers
//
//   UNAUTHENTICATED               401  no token, or a token no session matches
//   SESSION_EXPIRED               401  a real session whose window closed
//   SESSION_REVOKED               401  a real session somebody ended
//   TENANCY_ENVIRONMENT_FORBIDDEN 403  the four-gate RBAC decision said no
//   TENANCY_PROJECT_CREATE_FORBIDDEN 403 not a member of that organization
//
// and every status below is read out of `docs/error-taxonomy.json`, never
// written here.
//
// RATE_LIMITED IS NOT AMONG THEM, AND THAT IS A FINDING RATHER THAN AN OMISSION.
// `consumeRateLimit` is published, but its three actions are `LOGIN`,
// `INVITE_ACCEPT` and `MFA_VERIFY` — all pre-authentication credential
// operations — and NONE of the use cases that perform them is on either published
// contract (`startMagicLinkLogin`, `verifyMfaForSession` and `acceptInvitation`
// live in `application/` and are not exported through a contract). A V1 route may
// only reach a contract method, so there is no truthful V1 route that spends an
// authentication budget. `identity-rest.test.ts` states that as a CHECKED claim
// over the contract's own method names, so it goes red the day one is published.
//
// A second, smaller finding is recorded there too: `RateLimitRequest` requires a
// `TenantScope`, and a LOGIN refusal happens before any tenant is known.
//
// ---------------------------------------------------------------------------
// IT FAILS WHEN DOCKER IS ABSENT RATHER THAN SKIPPING. A skipped integration
// suite and a passing one look identical in a CI summary.
//
// ---------------------------------------------------------------------------
// WHY IT LIVES IN `composition/` AND NOT IN `transports/`
//
// Its subject is the transport, and it was written there first. C8 in
// `scripts/arch/composition-root.mjs` refused it — correctly. The suite seeds
// through `construction.adapters["postgres-tenancy"]`'s own ports (a fixture
// that wrote rows as SQL would be skipping the store under test), and C8's rule
// is about the DIRECTORY rather than about whether a particular file is "really"
// a transport, precisely so it cannot decay into a judgement call.
//
// The alternative was an exception list, and the exception would have been the
// first hole in a rule whose whole value is that it has none. So the suite moved
// to where its sibling `operator-authentication.integration.test.ts` already
// lives — the directory that composes an application and seeds it — and C8 keeps
// zero carve-outs.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asIdentifier } from "@platos/kernel";

import { loadPlatformConfiguration } from "../config/platform.js";
import { API_VERSION_PREFIX } from "../http/api-surface.js";
import { createProcessDefaults, startCoreApi, type RunningCoreApi } from "../runtime/lifecycle.js";
import { CONTRACT_VERSION_HEADER } from "../transports/rest/envelope.js";
import { constructAdapters, type AdapterConstruction } from "./adapter-bindings.js";
import { assembleContextPorts } from "./context-ports.js";

const TAXONOMY = JSON.parse(
  readFileSync(new URL("../../../../docs/error-taxonomy.json", import.meta.url), "utf8"),
) as { readonly codes: Readonly<Record<string, { readonly status: number }>> };

/** The status the COMMITTED taxonomy records — never a literal written here. */
function committedStatus(code: string): number {
  const entry = TAXONOMY.codes[code];
  if (entry === undefined) throw new Error(`${code} is not in the committed taxonomy`);
  return entry.status;
}

const AT = new Date("2026-05-01T09:00:00.000Z");
const ORGANIZATION = "bbbbbbbb-0001-4000-8000-000000000001";
const PROJECT = "bbbbbbbb-0002-4000-8000-000000000002";
const ENVIRONMENT = "bbbbbbbb-0003-4000-8000-000000000003";
const ADMIN = "bbbbbbbb-0004-4000-8000-000000000004";
const OUTSIDER = "bbbbbbbb-0005-4000-8000-000000000005";
const MEMBERSHIP = "bbbbbbbb-0006-4000-8000-000000000006";

/** Raw tokens an operator would present. Never stored; only their digests are. */
const ADMIN_TOKEN = "win267-r1-admin-session-token";
const OUTSIDER_TOKEN = "win267-r1-outsider-session-token";
const EXPIRED_TOKEN = "win267-r1-expired-session-token";
const REVOKED_TOKEN = "win267-r1-revoked-session-token";
const IMPERSONATION_TOKEN = "win267-r1-impersonation-session-token";

let postgres: StartedPostgreSqlContainer;
let redis: StartedRedisContainer;
let construction: AdapterConstruction;
let running: RunningCoreApi;
let base: string;

function packageRootRelative(...parts: string[]): string {
  return resolve(process.cwd(), ...parts);
}

/** Read a row back from a `psql` process inside the container. See the banner. */
async function observe(sql: string): Promise<string[]> {
  const result = await postgres.exec([
    "psql", "-U", postgres.getUsername(), "-d", postgres.getDatabase(),
    "-t", "-A", "-F", "|", "-c", sql,
  ]);
  if (result.exitCode !== 0) throw new Error(`psql refused: ${result.output}`);
  return result.output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
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
  options: { readonly token?: string; readonly cookie?: string; readonly body?: unknown } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  if (options.cookie !== undefined) headers["cookie"] = options.cookie;
  const response = await fetch(`${base}${path}`, {
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

function errorCode(answer: Answer): string {
  const error = answer.body["error"] as Record<string, unknown> | undefined;
  return typeof error?.["code"] === "string" ? (error["code"] as string) : `(no error: ${answer.text.slice(0, 120)})`;
}

beforeAll(async () => {
  postgres = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  redis = await new RedisContainer("redis:7-alpine").start();
  const databaseUrl = postgres.getConnectionUri();

  const databasePackage = packageRootRelative("../../internal-packages/tenancy-database");
  execFileSync(
    packageRootRelative("../../node_modules/.bin/prisma"),
    ["migrate", "deploy", "--schema", resolve(databasePackage, "prisma/schema.prisma")],
    { cwd: databasePackage, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" },
  );

  // EXACTLY WHAT `main.ts` DOES, in the same order and with the same calls, and
  // then the ONE step the contract-edge suite stops short of: it starts the
  // server.
  const platform = loadPlatformConfiguration({
    PLATOS_ENVIRONMENT: "test",
    PLATOS_CORE_API_PORT: "0",
    PLATOS_STORE_POSTGRES_URL: databaseUrl,
    PLATOS_STORE_REDIS_URL: redis.getConnectionUrl(),
    PLATOS_PROVIDERS_DEFAULT_MODEL: "anthropic:claude-haiku-4-5-20251001",
    PLATOS_SECURITY_ENCRYPTION_KEY: "c".repeat(64),
    PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "3",
  });
  if (!platform.ok) throw new Error(`platform configuration refused: ${JSON.stringify(platform.diagnostics)}`);
  const defaults = createProcessDefaults(platform.value.core);
  construction = constructAdapters({
    stores: platform.value.stores,
    security: platform.value.security,
    providers: platform.value.providers,
    clock: defaults.clock,
    correlation: null,
  });
  if (construction.faults.length > 0) throw new Error(construction.faults.join("; "));
  const assembly = assembleContextPorts(construction.adapters, defaults);

  const store = construction.adapters["postgres-tenancy"];
  if (store === undefined) throw new Error("postgres-tenancy must be constructed");
  const hasher = construction.adapters["node-crypto-digest"];
  if (hasher === undefined) throw new Error("node-crypto-digest must be constructed");

  // SEEDED THROUGH THE ADAPTER'S OWN PORTS, never as SQL: a fixture that wrote
  // these rows directly would be skipping the store under test.
  await store.unitOfWork.run(async (transaction) => {
    await store.saveOrganization(
      { id: asIdentifier(ORGANIZATION), slug: asIdentifier("win267-r1"), name: "WIN-267 R1", archivedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
    await store.saveProject(
      { id: asIdentifier(PROJECT), organizationId: asIdentifier(ORGANIZATION), slug: asIdentifier("r1-project"), name: "R1 project", archivedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
    await store.saveEnvironment(
      { id: asIdentifier(ENVIRONMENT), projectId: asIdentifier(PROJECT), slug: asIdentifier("prod"), name: "Production", archivedAt: null, accessKeyRevocationVersion: 0, memoryFeedbackBackfillCursor: null, memoryFeedbackBackfillCompletedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
  });
  await store.users.upsertByEmail(asIdentifier("r1-admin@example.test"), asIdentifier(ADMIN));
  await store.users.upsertByEmail(asIdentifier("r1-outsider@example.test"), asIdentifier(OUTSIDER));
  await store.unitOfWork.run(async (transaction) => {
    // The ADMIN is an organization OWNER, which passes gates 2 and 3 with no
    // project membership at all. The OUTSIDER holds NOTHING, which is what makes
    // the 403 cases below a refusal rather than an empty result set.
    await store.saveOrganizationMembership(
      { id: asIdentifier(MEMBERSHIP), organizationId: asIdentifier(ORGANIZATION), userId: asIdentifier(ADMIN), role: "OWNER", deactivatedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
  });

  const session = (id: string, token: string, extra: Record<string, unknown>): never =>
    ({
      sessionId: asIdentifier(id),
      tokenHash: hasher.hash(token),
      tier: "OPERATOR",
      userId: asIdentifier(ADMIN),
      impersonatedUserId: null,
      parentSessionId: null,
      mfaVerifiedAt: null,
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      revokedAt: null,
      lastSeenAt: null,
      createdAt: AT,
      ...extra,
    }) as never;

  await store.operatorSessions.save(session("bbbbbbbb-1001-4000-8000-000000000001", ADMIN_TOKEN, {}));
  await store.operatorSessions.save(
    session("bbbbbbbb-1002-4000-8000-000000000002", OUTSIDER_TOKEN, { userId: asIdentifier(OUTSIDER) }),
  );
  await store.operatorSessions.save(
    session("bbbbbbbb-1003-4000-8000-000000000003", EXPIRED_TOKEN, { expiresAt: new Date("2026-05-02T00:00:00.000Z") }),
  );
  await store.operatorSessions.save(
    session("bbbbbbbb-1004-4000-8000-000000000004", REVOKED_TOKEN, { revokedAt: AT }),
  );
  // AN IMPERSONATING SESSION: the ADMIN acting AS the OUTSIDER. It is the fixture
  // that separates `actorUserId` from `effectiveUserId`, and without it a route
  // that used the wrong one would pass every other case in this file.
  await store.operatorSessions.save(
    session("bbbbbbbb-1005-4000-8000-000000000005", IMPERSONATION_TOKEN, {
      impersonatedUserId: asIdentifier(OUTSIDER),
    }),
  );
  // `platformOperator` IS SET AS SQL, and it is the ONE thing in this fixture
  // that is. `evaluateImpersonation` refuses unless the actor carries the flag,
  // and NO published port writes it — `UserStore` exposes `findById`,
  // `findByEmail` and `upsertByEmail` and nothing else. The alternatives were a
  // second Prisma client, which `tenancy-prisma-only` pins to
  // `packages/adapters/postgres-tenancy` and forbids here, or dropping the case.
  // A `psql` process inside the container writes a column no contract owns.
  await observe(`UPDATE "User" SET "platformOperator" = true WHERE "id" = '${ADMIN}'`);

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
}, 300_000);

afterAll(async () => {
  await running?.stop("test");
  await construction?.release();
  await redis?.stop();
  await postgres?.stop();
});

describe("WIN-267 R1 — an operator authenticates over HTTP", () => {
  it("is not vacuous: identity-access and tenancy are COMPOSED in this process", () => {
    // Every case below would be meaningless against an uncomposed context: the
    // routes would answer `TRANSPORT_CONTEXT_UNAVAILABLE` and a suite that only
    // checked "not 200" would report green having proven nothing.
    expect(running.app.contexts.identityAccess?.name).toBe("identity-access");
    expect(running.app.contexts.tenancy?.name).toBe("tenancy");
  });

  it("answers the operator behind a live session token", async () => {
    const answer = await call("GET", `${API_VERSION_PREFIX}/identity/session`, { token: ADMIN_TOKEN });
    expect(answer.status, answer.text).toBe(200);
    const data = answer.body["data"] as Record<string, unknown>;
    // THE SEEDED USER, which is what makes this an authentication rather than a
    // boolean: a store that answered the wrong session would still return 200.
    expect(data["actorUserId"]).toBe(ADMIN);
    expect(data["email"]).toBe("r1-admin@example.test");
    expect(data["impersonating"]).toBeNull();
    // The M0.4 §2 ITEM envelope and the build stamp on every response.
    expect((answer.body["meta"] as Record<string, unknown>)["contractVersion"]).toBe(
      answer.headers.get(CONTRACT_VERSION_HEADER),
    );
  });

  it("stamps liveness, and a second connection sees it", async () => {
    await call("GET", `${API_VERSION_PREFIX}/identity/session`, { token: ADMIN_TOKEN });
    const rows = await observe(
      `SELECT COALESCE("lastSeenAt"::text, 'NULL') FROM "OperatorSession" WHERE "id" = 'bbbbbbbb-1001-4000-8000-000000000001'`,
    );
    expect(rows[0], "an authenticated request stamps liveness through the real store").not.toBe("NULL");
  });

  it("reads the cookie the CONTRACT names, not one this test invented", async () => {
    // The name is asked of `describeSessionCookie` at run time. Over plain HTTP
    // that is the unprefixed name, because `__Host-` requires Secure and a
    // browser would drop it. If the guard hardcoded either name, one of these two
    // requests would fail — and the pair is the only way to see which.
    const shape = running.app.contexts.identityAccess?.describeSessionCookie({ secure: false });
    expect(shape?.ok).toBe(true);
    const name = shape?.ok === true ? shape.value.name : "";
    expect(name).not.toBe("");
    const answer = await call("GET", `${API_VERSION_PREFIX}/identity/session`, {
      cookie: `${name}=${ADMIN_TOKEN}`,
    });
    expect(answer.status, answer.text).toBe(200);
    expect((answer.body["data"] as Record<string, unknown>)["actorUserId"]).toBe(ADMIN);
  });

  it("gives FOUR different answers to four different refusals", async () => {
    const anonymous = await call("GET", `${API_VERSION_PREFIX}/identity/session`);
    const unknown = await call("GET", `${API_VERSION_PREFIX}/identity/session`, { token: "not-a-token" });
    const expired = await call("GET", `${API_VERSION_PREFIX}/identity/session`, { token: EXPIRED_TOKEN });
    const revoked = await call("GET", `${API_VERSION_PREFIX}/identity/session`, { token: REVOKED_TOKEN });
    const forbidden = await call("GET", `${API_VERSION_PREFIX}/environments/${ENVIRONMENT}/end-users`, {
      token: OUTSIDER_TOKEN,
    });

    expect(errorCode(anonymous)).toBe("UNAUTHENTICATED");
    expect(errorCode(unknown)).toBe("UNAUTHENTICATED");
    expect(errorCode(expired)).toBe("SESSION_EXPIRED");
    expect(errorCode(revoked)).toBe("SESSION_REVOKED");
    expect(errorCode(forbidden)).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");

    // DISTINCTNESS, ASSERTED AS AN IDENTITY. Four codes and four of them.
    const codes = [anonymous, unknown, expired, revoked, forbidden].map(errorCode);
    expect(new Set(codes).size).toBe(4);

    // AND THE STATUSES COME FROM THE COMMITTED TAXONOMY, not from literals here.
    expect(anonymous.status).toBe(committedStatus("UNAUTHENTICATED"));
    expect(expired.status).toBe(committedStatus("SESSION_EXPIRED"));
    expect(revoked.status).toBe(committedStatus("SESSION_REVOKED"));
    expect(forbidden.status).toBe(committedStatus("TENANCY_ENVIRONMENT_FORBIDDEN"));

    // A FAILED AUTHENTICATION LEAVES NO TRACE: the expired session must still
    // carry a null liveness stamp, so a token cannot be confirmed to exist by
    // watching a timestamp move.
    expect(
      await observe(
        `SELECT COALESCE("lastSeenAt"::text, 'NULL') FROM "OperatorSession" WHERE "id" = 'bbbbbbbb-1003-4000-8000-000000000003'`,
      ),
    ).toEqual(["NULL"]);
  });
});

describe("WIN-267 R1 — impersonation, and the two user ids that are not the same", () => {
  it("names the real human as the actor and the impersonated account as effective", async () => {
    const answer = await call("GET", `${API_VERSION_PREFIX}/identity/session`, {
      token: IMPERSONATION_TOKEN,
    });
    expect(answer.status, answer.text).toBe(200);
    const data = answer.body["data"] as Record<string, unknown>;
    expect(data["actorUserId"], "the actor is the real human, always").toBe(ADMIN);
    expect(data["effectiveUserId"], "the effective user is whose permissions apply").toBe(OUTSIDER);
    expect(data["impersonating"]).toEqual({ targetUserId: OUTSIDER });
    // The email is the IMPERSONATED account's, which is the contract's own choice
    // (`effectiveUser = impersonatedUser ?? actor`) and the thing a dashboard
    // renders in the banner that says whose session this is.
    expect(data["email"]).toBe("r1-outsider@example.test");
  });

  it("lists the IMPERSONATED account's organizations, not the impersonator's", async () => {
    const answer = await call("GET", `${API_VERSION_PREFIX}/organizations`, { token: IMPERSONATION_TOKEN });
    expect(answer.status, answer.text).toBe(200);
    // THE WHOLE POINT. The ADMIN belongs to one organization and the OUTSIDER to
    // none. A route that passed `actorUserId` to `listOperatorOrganizations`
    // would answer with the ADMIN's organization here and would pass every other
    // case in this file — a support engineer would be shown their own tenant
    // while believing they were seeing the customer's, and nothing on the screen
    // would say so.
    expect(answer.body["data"]).toEqual([]);
  });

  it("refuses the environment to the impersonated account, on the impersonated account's memberships", async () => {
    const answer = await call("GET", `${API_VERSION_PREFIX}/environments/${ENVIRONMENT}/end-users`, {
      token: IMPERSONATION_TOKEN,
    });
    // Gate 2 evaluates the EFFECTIVE user's membership, and the OUTSIDER has
    // none — so impersonating does not carry the impersonator's access with it.
    expect(errorCode(answer)).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
  });
});

describe("WIN-267 R1 — a route does not widen what the contract permits", () => {
  it("REFUSES an unauthorized environment instead of answering an empty page", async () => {
    const answer = await call("GET", `${API_VERSION_PREFIX}/environments/${ENVIRONMENT}/end-users`, {
      token: OUTSIDER_TOKEN,
    });
    expect(answer.status).toBe(committedStatus("TENANCY_ENVIRONMENT_FORBIDDEN"));
    expect(errorCode(answer)).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
    // THE POINT OF THE CASE. An empty collection envelope would be a 200 with a
    // `data` array, and it is indistinguishable — to an operator, to a support
    // engineer, to a screenshot — from an environment that is genuinely empty.
    expect(answer.body["data"], "a refusal must not arrive as an empty list").toBeUndefined();
    expect(answer.body["page"]).toBeUndefined();
  });

  it("SERVES the same environment to an operator who holds the membership", async () => {
    const answer = await call("GET", `${API_VERSION_PREFIX}/environments/${ENVIRONMENT}/end-users`, {
      token: ADMIN_TOKEN,
    });
    // THE CONTROL. Without it the case above would pass against a route that
    // refused everybody, which is a route that has no authorization rule at all.
    expect(answer.status, answer.text).toBe(200);
    expect(Array.isArray(answer.body["data"])).toBe(true);
    const page = answer.body["page"] as Record<string, unknown>;
    expect(page["cursor"]).toBeNull();
    expect(page["hasMore"]).toBe(false);
    expect(page["total"]).toBe(0);
  });

  it("REFUSES a project created in an organization the operator is not in", async () => {
    const answer = await call("POST", `${API_VERSION_PREFIX}/projects`, {
      token: OUTSIDER_TOKEN,
      body: {
        organizationId: ORGANIZATION,
        name: "Smuggled",
        slug: "smuggled",
        environmentName: "Production",
        environmentSlug: "prod",
      },
    });
    expect(errorCode(answer)).toBe("TENANCY_PROJECT_CREATE_FORBIDDEN");
    expect(answer.status).toBe(committedStatus("TENANCY_PROJECT_CREATE_FORBIDDEN"));
    // AND NO ROW WAS WRITTEN. A 403 with a committed project would be the worst
    // of both, and only a second connection can tell us.
    expect(await observe(`SELECT count(*) FROM "Project" WHERE "slug" = 'smuggled'`)).toEqual(["0"]);
  });
});

describe("WIN-267 R1 — the tenancy read models and writes, over HTTP", () => {
  it("lists the organizations the operator belongs to, in the COLLECTION envelope", async () => {
    const answer = await call("GET", `${API_VERSION_PREFIX}/organizations`, { token: ADMIN_TOKEN });
    expect(answer.status, answer.text).toBe(200);
    const rows = answer.body["data"] as readonly Record<string, unknown>[];
    expect(rows.map((row) => row["id"])).toContain(ORGANIZATION);
    const membership = rows.find((row) => row["id"] === ORGANIZATION)?.["membership"] as Record<string, unknown>;
    expect(membership["role"]).toBe("OWNER");
    const page = answer.body["page"] as Record<string, unknown>;
    expect(page["total"]).toBe(rows.length);
    expect(page["hasMore"]).toBe(false);
  });

  it("shows the OUTSIDER none of them, which is a different answer from a refusal", async () => {
    const answer = await call("GET", `${API_VERSION_PREFIX}/organizations`, { token: OUTSIDER_TOKEN });
    // 200 WITH AN EMPTY LIST IS CORRECT HERE and 403 would be wrong: the listing
    // is keyed by the operator alone, so "you belong to none" is an ANSWER. The
    // end-user case above is the opposite because the caller named a scope. Both
    // cases in one suite is what stops either rule being applied to the other.
    expect(answer.status).toBe(200);
    expect(answer.body["data"]).toEqual([]);
  });

  it("refuses a page of a collection that is not paged", async () => {
    const answer = await call("GET", `${API_VERSION_PREFIX}/organizations?limit=5`, { token: ADMIN_TOKEN });
    expect(answer.status).toBe(committedStatus("TRANSPORT_REQUEST_INVALID"));
    expect(errorCode(answer)).toBe("TRANSPORT_REQUEST_INVALID");
    const fields = (answer.body["error"] as Record<string, unknown>)["fields"] as readonly Record<string, unknown>[];
    expect(fields.map((field) => field["field"])).toContain("query.limit");
  });

  it("CREATES an organization, and a second connection sees the founding owner", async () => {
    const answer = await call("POST", `${API_VERSION_PREFIX}/organizations`, {
      token: ADMIN_TOKEN,
      body: { name: "Second Org", slug: "r1-second" },
    });
    // 201 HERE, AND IT IS EARNED: a row that did not exist now does. The pair
    // with the BFF exchange's 200 is what makes each status a decision.
    expect(answer.status, answer.text).toBe(201);
    const data = answer.body["data"] as Record<string, unknown>;
    expect(data["slug"]).toBe("r1-second");
    // BOTH ROWS, OR NEITHER. `createOrganization` commits the organization and
    // its founding OWNER membership atomically because "an organization with no
    // owner has almost no path back"; the join below is what proves the HTTP
    // route did not get half of it.
    const rows = await observe(
      `SELECT o."id", m."role", m."userId" FROM "Organization" o
         JOIN "OrganizationMembership" m ON m."organizationId" = o."id"
        WHERE o."slug" = 'r1-second'`,
    );
    expect(rows).toEqual([`${String(data["id"])}|OWNER|${ADMIN}`]);
  });

  it("refuses a slug the DOMAIN rejects, with the domain's own code", async () => {
    const answer = await call("POST", `${API_VERSION_PREFIX}/organizations`, {
      token: ADMIN_TOKEN,
      body: { name: "Bad Slug", slug: "Not A Slug" },
    });
    // THE TRANSPORT DID NOT DECIDE THIS. `body.ts` checks only that the field is
    // a string; the grammar is `tenancy`'s, and its code is what reaches the
    // wire. A transport that validated slugs itself would answer
    // TRANSPORT_REQUEST_INVALID here and drift from the domain the first time
    // the grammar changed.
    expect(errorCode(answer)).toBe("TENANCY_INVALID_SLUG");
    expect(answer.status).toBe(committedStatus("TENANCY_INVALID_SLUG"));
  });

  it("reports every missing body field at once, in the envelope's fields[]", async () => {
    const answer = await call("POST", `${API_VERSION_PREFIX}/projects`, { token: ADMIN_TOKEN, body: {} });
    expect(answer.status).toBe(committedStatus("TRANSPORT_REQUEST_INVALID"));
    const fields = (answer.body["error"] as Record<string, unknown>)["fields"] as readonly Record<string, unknown>[];
    expect(fields.map((field) => field["field"]).sort()).toEqual([
      "body.environmentName",
      "body.environmentSlug",
      "body.name",
      "body.organizationId",
      "body.slug",
    ]);
  });

  it("CREATES a project with its first environment and the creator's membership", async () => {
    const answer = await call("POST", `${API_VERSION_PREFIX}/projects`, {
      token: ADMIN_TOKEN,
      body: {
        organizationId: ORGANIZATION,
        name: "R1 second project",
        slug: "r1-second-project",
        environmentName: "Staging",
        environmentSlug: "staging",
      },
    });
    expect(answer.status, answer.text).toBe(201);
    const data = answer.body["data"] as Record<string, unknown>;
    const project = data["project"] as Record<string, unknown>;
    // ALL THREE ROWS, COUNTED FROM OUTSIDE. `createProject` commits the project,
    // its first environment and an ADMIN project membership in one unit of work;
    // a route that reached only the first two would still answer 201.
    const rows = await observe(
      `SELECT p."id", e."slug", pm."role" FROM "Project" p
         JOIN "Environment" e ON e."projectId" = p."id"
         JOIN "ProjectMembership" pm ON pm."projectId" = p."id"
        WHERE p."slug" = 'r1-second-project'`,
    );
    expect(rows).toEqual([`${String(project["id"])}|staging|ADMIN`]);

    // AND IT IS VISIBLE THROUGH THE READ MODEL THAT REPLACED THE PRISMA WHERE.
    const listed = await call("GET", `${API_VERSION_PREFIX}/projects`, { token: ADMIN_TOKEN });
    const slugs = (listed.body["data"] as readonly Record<string, unknown>[]).map((row) => row["slug"]);
    expect(slugs).toContain("r1-second-project");
    expect(slugs).toContain("r1-project");
  });

  it("shows the OUTSIDER no projects at all", async () => {
    const answer = await call("GET", `${API_VERSION_PREFIX}/projects`, { token: OUTSIDER_TOKEN });
    expect(answer.status).toBe(200);
    // `listVisibleProjects` hides every project when the organization membership
    // is absent, "without a single ProjectMembership row changing". The rows are
    // there — the case above just created one — so this is a rule being applied,
    // not an empty table.
    expect(answer.body["data"]).toEqual([]);
  });
});

describe("WIN-267 R1 — the BFF sets bytes and nothing else", () => {
  it("exchanges a token for a cookie the CONTRACT shaped, and the cookie then authenticates", async () => {
    const answer = await call("POST", `${API_VERSION_PREFIX}/bff/session`, { body: { token: ADMIN_TOKEN } });
    // 200 AND NOT 201, AND THIS ASSERTION FOUND THE DEFECT. The first run of this
    // suite answered 201: Nest's default for a POST, which the handler had not
    // overridden. The exchange creates nothing — it moves a credential the caller
    // already holds into a cookie — so 201 would have told a client a resource
    // existed that it could not then address.
    expect(answer.status, answer.text).toBe(200);
    const setCookie = answer.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    const cookie = String(setCookie);
    // EVERY ATTRIBUTE THE CONTRACT DECIDED. Over plain HTTP that is the
    // unprefixed name and no `Secure`; `Domain` must be absent in every install.
    expect(cookie).toContain("platos_operator_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Domain=");
    expect(cookie).not.toContain("__Host-");

    // THE ROUND TRIP. The bytes the BFF wrote are handed straight back to the
    // guard, which asks the contract for the name again — so this proves the two
    // halves of the exchange agree without either of them being told the answer.
    const pair = cookie.split(";")[0] ?? "";
    const authenticated = await call("GET", `${API_VERSION_PREFIX}/identity/session`, { cookie: pair });
    expect(authenticated.status, authenticated.text).toBe(200);
    expect((authenticated.body["data"] as Record<string, unknown>)["actorUserId"]).toBe(ADMIN);
  });

  it("refuses to put an expired or unknown token in a browser, with distinct codes", async () => {
    const expired = await call("POST", `${API_VERSION_PREFIX}/bff/session`, { body: { token: EXPIRED_TOKEN } });
    const unknown = await call("POST", `${API_VERSION_PREFIX}/bff/session`, { body: { token: "nope" } });
    expect(errorCode(expired)).toBe("SESSION_EXPIRED");
    expect(errorCode(unknown)).toBe("UNAUTHENTICATED");
    expect(expired.headers.get("set-cookie"), "a refused exchange sets no cookie").toBeNull();
  });

  it("clears the cookie for anybody, authenticated or not", async () => {
    const answer = await call("DELETE", `${API_VERSION_PREFIX}/bff/session`);
    // NO AUTHENTICATION ON PURPOSE: a browser holding a dead credential is the
    // one that most needs it cleared, and a 401 here would strand it.
    expect(answer.status).toBe(204);
    const cookie = String(answer.headers.get("set-cookie"));
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("platos_operator_session=;");
  });
});
