// THE PROVIDER-KEY ROTATION, OVER HTTP, AGAINST A REAL DATABASE AND A REAL REDIS
// — AND THE IDEMPOTENCY CONTRACT PROVED AGAINST REAL CONCURRENCY.
//
// ---------------------------------------------------------------------------
// WHY THIS SUITE EXISTS
//
// `apps/core-api/src/http/idempotency-policy.ts` classes exactly eight
// operations `required`. `POST /api/v1/agent/providers/keys/:id/rotate-secret`
// is one of them, and until WIN-302 it had no handler in this process. The gate
// ran anyway — it is module middleware over `*`, so it sees a request whose
// route does not exist — which means a caller that OBEYED the contract and sent
// an `Idempotency-Key` was reserved, admitted, and handed the terminal
// `TRANSPORT_ROUTE_NOT_FOUND`. The reservation it then held recorded that 404
// and replayed it for every retry of the same key for twenty-four hours.
//
// ---------------------------------------------------------------------------
// WHAT A DOUBLE EXECUTION COSTS HERE, WHICH IS NOT WHAT THE MCP MINTS COST
//
// The two MCP mints protect a SECRET: a mint that ran twice would leave a live
// credential nobody knows about. This route returns no secret at all — the
// material travels inbound (BYOK) and the response is a `ProviderKeyView`
// projection. So the thing the key protects is the DOUBLE ROTATION, and it is
// worth naming precisely because it decides what this file has to measure:
//
//   `secrets.rotateCredential` INSERTS a new `CredentialSecretVersion`, retires
//   the previous one and repoints `Credential.activeSecretVersionId`. A second
//   execution inserts a SECOND version and advances `secretRevision` again, so
//   the credential ends two revisions ahead of the one rotation the operator
//   asked for — and every other provider key pointing at that credential moves
//   with it, because they share the material by construction.
//
//   `providers` then evicts the provider's probe cache. A rotation that ran
//   twice evicts twice, and the second eviction happens against a cache the
//   first pass already cleared.
//
// So the assertion is on `CredentialSecretVersion`: exactly ONE new row and
// exactly ONE revision of movement, whatever the two responses say.
//
// ---------------------------------------------------------------------------
// THE RACE IS REAL, AND SEQUENTIAL CALLS CANNOT REACH IT
//
// Calling the handler twice in sequence proves nothing about concurrency: the
// first call has already settled its reservation before the second starts, so
// the second takes the REPLAY path and the interesting branch — two requests in
// flight at once — is never entered. `Promise.all` over two `fetch` calls is
// what makes them race, and the count is read back by a `psql` PROCESS that
// shares no pool, driver or transaction with the adapter under test.
//
// ---------------------------------------------------------------------------
// WHERE THE SERVERS COME FROM, AND WHY THERE IS AN ESCAPE HATCH
//
// The default is testcontainers, exactly as `mcp-token-mint.integration.test.ts`
// does it. `PLATOS_POSTGRES_INTEGRATION_DATABASE_URL` and
// `PLATOS_REDIS_INTEGRATION_URL` point it at servers an operator already has, and
// neither name is new: the sibling suite in this directory reads both, five more
// under `apps/agent` read the first, and `HARNESS_DATABASE_URL_VARIABLE` in
// `packages/adapters/postgres-tenancy/src/harness.ts` states the rule they all
// follow — "the supplied server is not this harness's to shut down". That is what
// lets this suite be PROVEN on a workstation where Docker may not run, rather
// than written against a runner nobody here can reach.
//
// A SUPPLIED SERVER IS NOT A WEAKER TEST. The assertions do not know which path
// produced the URL; the only branch is `observe`, which runs `psql` inside the
// container when there is one and on the host when the URL was supplied. Both
// are a separate process reading committed rows, which is the whole requirement.
//
// IT FAILS WHEN NEITHER IS AVAILABLE RATHER THAN SKIPPING. A skipped integration
// suite and a passing one look identical in a CI summary.
//
// ---------------------------------------------------------------------------
// WHY IT LIVES IN `composition/`. C8 in `scripts/arch/composition-root.mjs`
// refuses a suite under `transports/` that reaches the adapters to seed, and it
// refuses it by DIRECTORY so the rule cannot decay into a judgement call. Its
// three siblings here are here for the same reason.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { psqlConnectionUrl } from "./integration-database.js";

import { asIdentifier, type EnvironmentId } from "@platos/kernel";
import type { UserId } from "@platos/context-tenancy";

import { loadPlatformConfiguration } from "../config/platform.js";
import { API_VERSION_PREFIX } from "../http/api-surface.js";
import { createProcessDefaults, startCoreApi, type RunningCoreApi } from "../runtime/lifecycle.js";
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

/**
 * THE AMBIENT ENVIRONMENT, COPIED AND FROZEN ONCE.
 *
 * ONE READ, AT MODULE LOAD, AND EVERY LOOKUP BELOW IS OFF THE COPY. That is the
 * shape `scripts/arch/env-access.mjs` declares for a test-support file and the
 * shape its sibling `mcp-organization-policy.integration.test.ts` already uses —
 * a suite that reached for `process.env` per call would show up on that gate as
 * several readers, and the register it is declared in states a `reads` count.
 *
 * THE VARIABLE NAMES ARE THE ONES THIS REPOSITORY ALREADY HAS.
 * `PLATOS_POSTGRES_INTEGRATION_DATABASE_URL` and `PLATOS_REDIS_INTEGRATION_URL`
 * are read by the sibling suite in this directory and by five more under
 * `apps/agent`; `PLATOS_PSQL_BINARY` overrides the client the observer spawns.
 * This file invented three new names first, which would have been a second
 * spelling of a decision that already had one.
 */
const AMBIENT: Readonly<Record<string, string | undefined>> = Object.freeze({ ...process.env });

function supplied(variable: string): string | null {
  const value = AMBIENT[variable];
  return value === undefined || value.trim() === "" ? null : value.trim();
}

/** See the banner: servers an operator supplied, or null for the container path. */
export const SUPPLIED_POSTGRES_URL_VARIABLE = "PLATOS_POSTGRES_INTEGRATION_DATABASE_URL";
export const SUPPLIED_REDIS_URL_VARIABLE = "PLATOS_REDIS_INTEGRATION_URL";

const AT = new Date("2026-05-01T09:00:00.000Z");

/**
 * A NONCE EVERY FIXTURE ID AND EVERY `Idempotency-Key` IN THIS FILE CARRIES.
 *
 * ---------------------------------------------------------------------------
 * WHY THE IDS ARE NOT CONSTANTS, WHICH IS WHAT THIS FILE TRIED FIRST
 *
 * A SUPPLIED SERVER IS REUSED, which the container path never is, so the seed
 * has to be re-runnable. Fixed ids are not, and the reason is a DATABASE RULE
 * rather than an inconvenience — measured by trying to write the teardown:
 *
 *   `registerProviderKey` refuses a duplicate label with
 *   `PROVIDERS_KEY_ALREADY_EXISTS`, so the second run must first remove the
 *   first run's rows.
 *
 *   Deleting the organization subtree is refused: `CredentialAudit` holds a
 *   RESTRICT reference to `Environment`.
 *
 *   And deleting the audit rows is refused outright by the
 *   `CredentialAudit_immutable_delete` rule the schema installs, which raises
 *   "CredentialAudit is immutable". Under ADR M0.3 §1 row 3 `secrets` is that
 *   table's sole writer and the ledger is APPEND-ONLY, so "reset the fixtures"
 *   is not an operation this schema offers to anybody, including a test.
 *
 * So each run seeds its OWN organization subtree and deletes nothing. That is
 * the only shape an immutable audit ledger permits, and it is also the safer
 * one: nothing here can remove a row it did not create.
 *
 * ---------------------------------------------------------------------------
 * IT IS ALSO WHAT MAKES THE IDEMPOTENCY KEYS HONEST
 *
 * A reservation lives twenty-four hours (`REQUEST_IDEMPOTENCY_TTL_SECONDS`), so
 * a second run against a supplied Redis would find every key already settled,
 * take the replay path, and measure a rotation that never happened — a green
 * suite proving nothing. The container path hides that, which is exactly the
 * class of defect an escape hatch introduces. Nothing here flushes a keyspace it
 * does not own.
 */
const RUN = Date.now().toString(16).padStart(12, "0").slice(-12);

/**
 * One fixture id, unique to this run.
 *
 * A VALID UUID BY CONSTRUCTION — version 4, variant 1 — because every column
 * below is `@db.Uuid` and PostgreSQL refuses anything else. The discriminator is
 * the caller's, so two fixtures of this run can never collide with each other.
 */
function fixtureId(discriminator: string): string {
  return `${FIXTURE_FAMILY}-${discriminator.padStart(4, "0")}-4000-8000-${RUN}`;
}

/**
 * THE ID FAMILY THIS SUITE OWNS, AND WHY IT IS NOT `dddddddd`.
 *
 * Each suite in this directory takes a family and the four before this one had
 * taken `aaaaaaaa` (operator-authentication), `bbbbbbbb` (identity-rest),
 * `cccccccc` (mcp-token-mint) and `dddddddd` (mcp-organization-policy and
 * stream-lane). This file's first draft took `dddddddd` too, with FIXED ids, and
 * `dddddddd-0001-4000-8000-000000000001` was byte-identical to
 * `ALPHA_ORGANIZATION` in `mcp-organization-policy.integration.test.ts` — which
 * matters because both suites read `PLATOS_POSTGRES_INTEGRATION_DATABASE_URL` and
 * therefore share one database when an operator supplies it. That suite's teardown
 * deletes its organization by exact id, so it would have deleted this one's.
 *
 * MEASURED, NOT IMAGINED: running the two together is what surfaced it, and the
 * symptom was the SIBLING going red — its `DELETE FROM "Organization"` refused,
 * because rows this file had left behind held the RESTRICT reference described
 * under `RUN`. A collision between fixtures shows up as a failure in the other
 * suite, which is the hardest kind to attribute.
 *
 * The per-run nonce in the last segment already makes a collision impossible, so
 * this constant is belt and braces — and it is the half a reader can check at a
 * glance.
 */
const FIXTURE_FAMILY = "eeeeeeee";

/** Every `Idempotency-Key` this file sends. See `RUN`. */
function idempotencyKey(name: string): string {
  return `win302-${RUN}-${name}`;
}

const ORGANIZATION = fixtureId("1");
const PROJECT = fixtureId("2");
const ENVIRONMENT = fixtureId("3");
const ADMIN = fixtureId("4");
const OUTSIDER = fixtureId("5");
const MEMBERSHIP = fixtureId("6");
/**
 * A REAL MEMBER OF THE ORGANIZATION WHO IS NOT AN ADMIN.
 *
 * The outsider proves a refusal at gate 2 — no membership at all — and a route
 * asking for `metadata` would refuse them too, so the outsider alone cannot tell
 * the two access levels apart. This member passes gates 1, 2 and 3 and is
 * refused ONLY by gate 4, which is the gate that narrows `secret:mutate`.
 * Without this fixture a rotation that asked for `metadata` would pass every
 * case in this file.
 */
const MEMBER = fixtureId("a");
const MEMBER_MEMBERSHIP = fixtureId("b");
const MEMBER_PROJECT_MEMBERSHIP = fixtureId("c");
/**
 * A SECOND environment under a SECOND project of the SAME organization.
 *
 * It is what makes the cross-environment case a FORGED PAIR rather than a
 * foreign tenant: the admin may administer both, and the provider key belongs to
 * only one of them. A two-tenant fixture would be refused at gate 2 and would
 * therefore not test the scope clause at all.
 */
const OTHER_PROJECT = fixtureId("7");
const OTHER_ENVIRONMENT = fixtureId("8");

const ADMIN_TOKEN = `win302-${RUN}-admin-session-token`;
const OUTSIDER_TOKEN = `win302-${RUN}-outsider-session-token`;
const MEMBER_TOKEN = `win302-${RUN}-member-session-token`;

const PROVIDER = "anthropic";
const CREDENTIAL_NAME = `win302-${RUN}-rotating-key`;
const ORIGINAL_SECRET = "sk-ant-win302-original-material";

let postgres: StartedPostgreSqlContainer | null = null;
let redis: StartedRedisContainer | null = null;
let databaseUrl: string;
let construction: AdapterConstruction;
let running: RunningCoreApi;
let base: string;
/** The key the suite rotates, and the credential behind it. Seeded, not assumed. */
let providerKeyId: string;
let credentialId: string;

function packageRootRelative(...parts: string[]): string {
  return resolve(process.cwd(), ...parts);
}

/**
 * Read committed rows back from a `psql` PROCESS.
 *
 * THE ONE BRANCH IN THIS FILE, and it decides only WHERE psql runs: inside the
 * container when this suite started one, on the host when the URL was supplied.
 * Both are a separate process holding its own connection, which is the property
 * the race case depends on — an assertion made through the adapter's own pool
 * could be answered from a transaction the adapter had not committed.
 */
async function observe(sql: string): Promise<string[]> {
  const lines =
    postgres === null
      ? execFileSync(
          AMBIENT["PLATOS_PSQL_BINARY"] ?? "psql",
          // TRANSLATED, NOT PASSED THROUGH. The supplied url is a PRISMA url and
          // the canonical one in `ci.yml` ends `?schema=public`, which `psql`
          // refuses outright — "invalid URI query parameter". See
          // `integration-database.ts`.
          [psqlConnectionUrl(databaseUrl), "-t", "-A", "-F", "|", "-c", sql],
          { encoding: "utf8" },
        )
      : await (async (): Promise<string> => {
          const result = await postgres.exec([
            "psql", "-U", postgres.getUsername(), "-d", postgres.getDatabase(),
            "-t", "-A", "-F", "|", "-c", sql,
          ]);
          if (result.exitCode !== 0) throw new Error(`psql refused: ${result.output}`);
          return result.output;
        })();
  return lines.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
  readonly text: string;
}

async function post(
  path: string,
  options: {
    readonly token?: string;
    readonly key?: string;
    readonly body?: unknown;
  } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  if (options.key !== undefined) headers["idempotency-key"] = options.key;
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? {}),
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
  return typeof error?.["code"] === "string"
    ? (error["code"] as string)
    : `(no error: ${answer.text.slice(0, 200)})`;
}

function data(answer: Answer): Record<string, unknown> {
  return (answer.body["data"] ?? {}) as Record<string, unknown>;
}

function rotatePath(id: string): string {
  return `${API_VERSION_PREFIX}/agent/providers/keys/${id}/rotate-secret`;
}

/** A body the route accepts. `environmentId` is a FIELD, never a header. */
function rotateBody(secret: string, environmentId: string = ENVIRONMENT): Record<string, unknown> {
  return { environmentId, plaintext: secret };
}

/** How many secret versions that credential carries, and its highest revision. */
async function secretVersions(): Promise<{ count: number; revision: number }> {
  const rows = await observe(
    `SELECT count(*), coalesce(max("secretRevision"), 0) FROM "CredentialSecretVersion"` +
      ` WHERE "credentialId" = '${credentialId}'`,
  );
  const [count, revision] = (rows[0] ?? "0|0").split("|");
  return { count: Number(count), revision: Number(revision) };
}

beforeAll(async () => {
  const suppliedPostgres = supplied(SUPPLIED_POSTGRES_URL_VARIABLE);
  const suppliedRedis = supplied(SUPPLIED_REDIS_URL_VARIABLE);
  // BOTH OR NEITHER. One supplied and one containerised would be a configuration
  // nobody asked for and the slowest way to discover a typo in a variable name.
  if ((suppliedPostgres === null) !== (suppliedRedis === null)) {
    throw new Error(
      `supply BOTH ${SUPPLIED_POSTGRES_URL_VARIABLE} and ${SUPPLIED_REDIS_URL_VARIABLE}, or neither`,
    );
  }
  if (suppliedPostgres === null) {
    postgres = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    redis = await new RedisContainer("redis:7-alpine").start();
  }
  databaseUrl = suppliedPostgres ?? (postgres as StartedPostgreSqlContainer).getConnectionUri();
  const redisUrl = suppliedRedis ?? (redis as StartedRedisContainer).getConnectionUrl();

  const databasePackage = packageRootRelative("../../internal-packages/tenancy-database");
  execFileSync(
    packageRootRelative("../../node_modules/.bin/prisma"),
    ["migrate", "deploy", "--schema", resolve(databasePackage, "prisma/schema.prisma")],
    { cwd: databasePackage, env: { ...AMBIENT, DATABASE_URL: databaseUrl }, stdio: "pipe" },
  );

  const platform = loadPlatformConfiguration({
    PLATOS_ENVIRONMENT: "test",
    PLATOS_CORE_API_PORT: "0",
    PLATOS_STORE_POSTGRES_URL: databaseUrl,
    // THE IDEMPOTENCY STORE IS REAL AND IS THE POINT. With no Redis the gate
    // fails closed on every keyed request, and this suite would be measuring
    // that refusal instead of the contract.
    PLATOS_STORE_REDIS_URL: redisUrl,
    PLATOS_PROVIDERS_DEFAULT_MODEL: "anthropic:claude-haiku-4-5-20251001",
    PLATOS_SECURITY_ENCRYPTION_KEY: "e".repeat(64),
    PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "3",
  });
  if (!platform.ok) {
    throw new Error(`platform configuration refused: ${JSON.stringify(platform.diagnostics)}`);
  }
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
  if (store === undefined) throw new Error("postgres-tenancy must be constructed");
  const hasher = construction.adapters["node-crypto-digest"];
  if (hasher === undefined) throw new Error("node-crypto-digest must be constructed");

  // SEEDED THROUGH THE ADAPTER'S OWN PORTS, never as SQL: a fixture that wrote
  // these rows directly would be skipping the store under test.
  await store.unitOfWork.run(async (transaction) => {
    await store.saveOrganization(
      { id: asIdentifier(ORGANIZATION), slug: asIdentifier(`win302-${RUN}`), name: "WIN-302", archivedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
    await store.saveProject(
      { id: asIdentifier(PROJECT), organizationId: asIdentifier(ORGANIZATION), slug: asIdentifier(`win302-${RUN}-project`), name: "WIN-302 project", archivedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
    await store.saveProject(
      { id: asIdentifier(OTHER_PROJECT), organizationId: asIdentifier(ORGANIZATION), slug: asIdentifier(`win302-${RUN}-other`), name: "WIN-302 other project", archivedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
    await store.saveEnvironment(
      { id: asIdentifier(ENVIRONMENT), projectId: asIdentifier(PROJECT), slug: asIdentifier("prod"), name: "Production", archivedAt: null, accessKeyRevocationVersion: 0, memoryFeedbackBackfillCursor: null, memoryFeedbackBackfillCompletedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
    await store.saveEnvironment(
      { id: asIdentifier(OTHER_ENVIRONMENT), projectId: asIdentifier(OTHER_PROJECT), slug: asIdentifier("prod"), name: "Other production", archivedAt: null, accessKeyRevocationVersion: 0, memoryFeedbackBackfillCursor: null, memoryFeedbackBackfillCompletedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
  });
  await store.users.upsertByEmail(asIdentifier(`win302-${RUN}-admin@example.test`), asIdentifier(ADMIN));
  await store.users.upsertByEmail(asIdentifier(`win302-${RUN}-outsider@example.test`), asIdentifier(OUTSIDER));
  await store.users.upsertByEmail(asIdentifier(`win302-${RUN}-member@example.test`), asIdentifier(MEMBER));
  await store.unitOfWork.run(async (transaction) => {
    // OWNER, because gate 4 narrows `secret:mutate` to an organization admin or
    // a project ADMIN.
    await store.saveOrganizationMembership(
      { id: asIdentifier(MEMBERSHIP), organizationId: asIdentifier(ORGANIZATION), userId: asIdentifier(ADMIN), role: "OWNER", deactivatedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
    await store.saveOrganizationMembership(
      { id: asIdentifier(MEMBER_MEMBERSHIP), organizationId: asIdentifier(ORGANIZATION), userId: asIdentifier(MEMBER), role: "MEMBER", deactivatedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
    await store.saveProjectMembership(
      { id: asIdentifier(MEMBER_PROJECT_MEMBERSHIP), projectId: asIdentifier(PROJECT), organizationMembershipId: asIdentifier(MEMBER_MEMBERSHIP), organizationId: asIdentifier(ORGANIZATION), role: "EDITOR", createdAt: AT, updatedAt: AT } as never,
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

  await store.operatorSessions.save(session(fixtureId("1001"), ADMIN_TOKEN, {}));
  await store.operatorSessions.save(
    session(fixtureId("1002"), OUTSIDER_TOKEN, { userId: asIdentifier(OUTSIDER) }),
  );
  await store.operatorSessions.save(
    session(fixtureId("1003"), MEMBER_TOKEN, { userId: asIdentifier(MEMBER) }),
  );

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

  // THE KEY UNDER TEST IS SEEDED THROUGH THE COMPOSED CONTRACT, not as SQL.
  // `registerProviderKey` is what puts material in the vault and points a new key
  // at it, and using it means the fixture this suite rotates was built by the
  // same path a real operator builds one — including the `CredentialSecretVersion`
  // whose revision the race case counts from.
  const providers = running.app.contexts.providers;
  const tenancy = running.app.contexts.tenancy;
  if (providers === undefined || tenancy === undefined) {
    throw new Error("providers and tenancy must both be composed for this suite to mean anything");
  }
  const grant = await tenancy.authorizeEnvironmentOperator({
    environmentId: asIdentifier<EnvironmentId>(ENVIRONMENT),
    operator: {
      actorUserId: asIdentifier<UserId>(ADMIN),
      effectiveUserId: asIdentifier<UserId>(ADMIN),
    },
    access: "secret:mutate",
  });
  if (!grant.ok) throw new Error(`seed authorization refused: ${grant.error.code}`);
  const registered = await providers.registerProviderKey({
    authorization: grant.value,
    intake: { provider: PROVIDER, label: `WIN-302 ${RUN} rotating key`, credentialName: CREDENTIAL_NAME, isDefault: true },
    plaintext: ORIGINAL_SECRET,
  });
  if (!registered.ok) throw new Error(`seed registration refused: ${registered.error.code}`);
  providerKeyId = registered.value.providerKeyId;
  credentialId = (await observe(
    `SELECT "credentialId" FROM "ProviderKey" WHERE "id" = '${providerKeyId}'`,
  ))[0] as string;
}, 300_000);

afterAll(async () => {
  await running?.stop("test");
  await construction?.release();
  // A SUPPLIED SERVER IS NOT THIS SUITE'S TO SHUT DOWN, which is the same rule
  // `startTenancyHarness` states. Both handles are null on that path.
  await redis?.stop();
  await postgres?.stop();
});

describe("WIN-302 — the third bound mint is served, and served exactly once", () => {
  it("is not vacuous: providers is composed and the idempotency store is real", () => {
    // Every case below would be meaningless against an uncomposed process: the
    // route would answer `TRANSPORT_CONTEXT_UNAVAILABLE` and a suite that only
    // checked "not 200" would report green having proven nothing. And without the
    // idempotency store every keyed request is refused fail-closed, so the race
    // case would be measuring the refusal rather than the contract.
    expect(running.app.contexts.providers?.name).toBe("providers");
    expect(running.app.contexts.tenancy?.name).toBe("tenancy");
    expect(running.app.contexts.secrets?.name).toBe("secrets");
    expect(running.app.requestIdempotency).not.toBeNull();
  });

  /**
   * THE FLOOR EVERY "ONE MORE ROW" BELOW IS MEASURED FROM.
   *
   * `registerProviderKey` put ONE version in the vault, so the fixture starts at
   * revision 1. Without this case a suite whose seed had silently written two
   * versions would still pass every relative assertion below.
   */
  it("starts from exactly one secret version at revision 1", async () => {
    expect(await secretVersions()).toEqual({ count: 1, revision: 1 });
  });

  it("refuses a keyless rotation before it executes, and writes nothing", async () => {
    const before = await secretVersions();
    const answer = await post(rotatePath(providerKeyId), {
      token: ADMIN_TOKEN,
      body: rotateBody("sk-ant-win302-keyless"),
    });
    expect(answer.status).toBe(committedStatus("IDEMPOTENCY_KEY_REQUIRED"));
    expect(errorCode(answer)).toBe("IDEMPOTENCY_KEY_REQUIRED");
    // THE HALF THAT MATTERS. A gate that refused AFTER the handler ran would
    // return the same code and leave a rotated credential behind it.
    expect(await secretVersions()).toEqual(before);
  });

  it("rotates once with a key, and the response carries no material", async () => {
    const before = await secretVersions();
    const answer = await post(rotatePath(providerKeyId), {
      token: ADMIN_TOKEN,
      key: idempotencyKey("happy"),
      body: rotateBody("sk-ant-win302-second-material"),
    });
    expect(answer.status, answer.text).toBe(200);
    const key = data(answer);
    expect(key["providerKeyId"]).toBe(providerKeyId);
    expect(key["credentialName"]).toBe(CREDENTIAL_NAME);
    // THE RESPONSE IS SEARCHED FOR THE MATERIAL RATHER THAN CHECKED FIELD BY
    // FIELD. A field-name assertion would pass the day somebody added a field
    // that carried it; this fails whatever the field is called.
    expect(answer.text).not.toContain("sk-ant-win302-second-material");
    expect(answer.text).not.toContain(ORIGINAL_SECRET);
    // EXACTLY ONE MORE VERSION, ONE REVISION ON.
    expect(await secretVersions()).toEqual({ count: before.count + 1, revision: before.revision + 1 });
    // AND THE MATERIAL IS NOWHERE IN THE DATABASE IN THE CLEAR.
    expect(
      await observe(
        `SELECT count(*) FROM "CredentialSecretVersion" WHERE "ciphertext"::text LIKE '%win302-second-material%'`,
      ),
    ).toEqual(["0"]);
  });

  it("replays a settled rotation byte for byte instead of rotating again", async () => {
    const key = idempotencyKey("replay");
    const body = rotateBody("sk-ant-win302-replayed-material");
    const first = await post(rotatePath(providerKeyId), { token: ADMIN_TOKEN, key, body });
    expect(first.status, first.text).toBe(200);
    const afterFirst = await secretVersions();

    const second = await post(rotatePath(providerKeyId), { token: ADMIN_TOKEN, key, body });
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(second.text).toBe(first.text);
    // THE ASSERTION THAT MAKES THE HEADER MEAN SOMETHING: the replay did not run.
    expect(await secretVersions()).toEqual(afterFirst);
  });

  it("refuses the same key with a different body rather than answering it", async () => {
    const key = idempotencyKey("mismatch");
    const first = await post(rotatePath(providerKeyId), {
      token: ADMIN_TOKEN,
      key,
      body: rotateBody("sk-ant-win302-mismatch-one"),
    });
    expect(first.status, first.text).toBe(200);
    const afterFirst = await secretVersions();
    const second = await post(rotatePath(providerKeyId), {
      token: ADMIN_TOKEN,
      key,
      body: rotateBody("sk-ant-win302-mismatch-two"),
    });
    expect(second.status).toBe(committedStatus("IDEMPOTENCY_REQUEST_MISMATCH"));
    expect(errorCode(second)).toBe("IDEMPOTENCY_REQUEST_MISMATCH");
    expect(await secretVersions()).toEqual(afterFirst);
  });

  /**
   * THE CASE THIS FILE EXISTS FOR.
   *
   * Two sockets, one key, one body, dispatched together. One of them executes;
   * the other either finds the reservation IN FLIGHT or replays the settled
   * answer, and WHICH of those two it gets is a timing detail this case
   * deliberately does not pin — both are correct, and asserting one would make
   * the test fail on a fast machine for a reason that is not a defect.
   *
   * WHAT IS PINNED IS THE DATABASE. Exactly one new `CredentialSecretVersion` and
   * exactly one revision of movement, read by a separate `psql` process. That is
   * the claim a sequential pair of calls cannot make.
   */
  it("produces ONE rotation from two racing requests, counted outside the pool", async () => {
    const before = await secretVersions();
    const key = idempotencyKey("race");
    const body = rotateBody("sk-ant-win302-raced-material");
    const [left, right] = await Promise.all([
      post(rotatePath(providerKeyId), { token: ADMIN_TOKEN, key, body }),
      post(rotatePath(providerKeyId), { token: ADMIN_TOKEN, key, body }),
    ]);

    const statuses = [left.status, right.status].sort((a, b) => a - b);
    const winners = [left, right].filter((answer) => answer.status === 200);
    // AT LEAST ONE SUCCEEDED — a race that refused both would satisfy a
    // row-count assertion and serve nobody.
    expect(winners.length, `statuses ${statuses.join(",")}`).toBeGreaterThanOrEqual(1);
    const loser = [left, right].find((answer) => answer.status !== 200);
    if (loser !== undefined) {
      expect(errorCode(loser)).toBe("IDEMPOTENCY_REQUEST_IN_FLIGHT");
      expect(loser.status).toBe(committedStatus("IDEMPOTENCY_REQUEST_IN_FLIGHT"));
    } else {
      // Both answered 200, so the second one MUST have been a replay rather than
      // a second execution — otherwise the row count below is the only thing
      // standing between this contract and two rotations.
      const replayed = [left, right].filter(
        (answer) => answer.headers.get("idempotency-replayed") === "true",
      );
      expect(replayed).toHaveLength(1);
    }

    // ONE ROW. WHATEVER THE TWO RESPONSES SAID.
    expect(await secretVersions()).toEqual({
      count: before.count + 1,
      revision: before.revision + 1,
    });
  });

  it("refuses an operator with no membership at all, by its own code", async () => {
    const before = await secretVersions();
    const answer = await post(rotatePath(providerKeyId), {
      token: OUTSIDER_TOKEN,
      key: idempotencyKey("outsider"),
      body: rotateBody("sk-ant-win302-outsider"),
    });
    expect(errorCode(answer)).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
    expect(answer.status).toBe(committedStatus("TENANCY_ENVIRONMENT_FORBIDDEN"));
    expect(await secretVersions()).toEqual(before);
  });

  /**
   * THE CASE THAT SEPARATES `secret:mutate` FROM `metadata`.
   *
   * This member passes gates 1, 2 and 3 — a real organization membership and a
   * real project membership — and is refused only by gate 4. A route that asked
   * tenancy for `metadata` would let them through, and nothing else in this file
   * would notice.
   */
  it("refuses a real member whom only gate 4 stops", async () => {
    const before = await secretVersions();
    const answer = await post(rotatePath(providerKeyId), {
      token: MEMBER_TOKEN,
      key: idempotencyKey("member"),
      body: rotateBody("sk-ant-win302-member"),
    });
    expect(errorCode(answer)).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
    expect(await secretVersions()).toEqual(before);
  });

  it("refuses a malformed body by NAMING the field, and never reaches the domain", async () => {
    const before = await secretVersions();
    const answer = await post(rotatePath(providerKeyId), {
      token: ADMIN_TOKEN,
      key: idempotencyKey("malformed"),
      body: { environmentId: ENVIRONMENT },
    });
    expect(errorCode(answer)).toBe("TRANSPORT_REQUEST_INVALID");
    const error = answer.body["error"] as { readonly fields?: readonly { field: string }[] };
    expect((error.fields ?? []).map((field) => field.field)).toContain("body.plaintext");
    expect(await secretVersions()).toEqual(before);
  });

  /**
   * A FORGED PAIR, NOT A FOREIGN TENANT.
   *
   * The admin genuinely administers both environments, and the provider key
   * belongs to only one. So gate 4 passes, the authorization is real, and the
   * refusal has to come from the SCOPE the key is looked up in — which is the
   * clause a two-tenant fixture would never reach because gate 2 would have
   * refused first.
   */
  it("refuses a key from another environment the same admin administers", async () => {
    const before = await secretVersions();
    const answer = await post(rotatePath(providerKeyId), {
      token: ADMIN_TOKEN,
      key: idempotencyKey("forged-pair"),
      body: rotateBody("sk-ant-win302-forged", OTHER_ENVIRONMENT),
    });
    expect(answer.status, answer.text).not.toBe(200);
    expect(errorCode(answer)).toBe("PROVIDERS_KEY_NOT_FOUND");
    expect(await secretVersions()).toEqual(before);
  });

  it("refuses a provider key id that no row carries", async () => {
    const answer = await post(rotatePath(fixtureId("ffff")), {
      token: ADMIN_TOKEN,
      key: idempotencyKey("absent"),
      body: rotateBody("sk-ant-win302-absent"),
    });
    expect(errorCode(answer)).toBe("PROVIDERS_KEY_NOT_FOUND");
    expect(answer.status).toBe(committedStatus("PROVIDERS_KEY_NOT_FOUND"));
  });

  it("refuses an unauthenticated caller before any tenancy decision", async () => {
    const answer = await post(rotatePath(providerKeyId), {
      key: idempotencyKey("anonymous"),
      body: rotateBody("sk-ant-win302-anonymous"),
    });
    expect(errorCode(answer)).toBe("UNAUTHENTICATED");
    expect(answer.status).toBe(committedStatus("UNAUTHENTICATED"));
  });
});
