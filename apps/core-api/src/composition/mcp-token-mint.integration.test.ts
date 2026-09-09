// THE TWO MCP TOKEN MINTS, OVER HTTP, AGAINST A REAL DATABASE AND A REAL REDIS —
// AND THE IDEMPOTENCY CONTRACT PROVED AGAINST REAL CONCURRENCY.
//
// ---------------------------------------------------------------------------
// WHY THIS SUITE EXISTS
//
// `apps/core-api/src/http/idempotency-policy.ts` classes exactly eight
// operations `required`. Two of them are `POST /mcp/platform/tokens` and
// `POST /mcp/entity/:entityId/tokens`, and until WIN-268 P1 NEITHER had a
// handler in this process. The gate ran anyway — it is module middleware over
// `*`, so it sees a request whose route does not exist — which means a caller
// that obeyed the contract and sent an `Idempotency-Key` was RESERVED, admitted,
// and then handed the terminal `TRANSPORT_ROUTE_NOT_FOUND`. The reservation it
// then held recorded that 404 and replayed it for every retry of the same key
// for twenty-four hours.
//
// So the claim this file has to prove is not "the route works". It is:
//
//   1. the mint executes and returns a secret that is NOWHERE in the database;
//   2. without a key it does not execute at all;
//   3. TWO IDENTICAL REQUESTS RACING produce ONE ROW and ONE SECRET;
//   4. a retry after the first settles replays the SAME secret, byte for byte;
//   5. the same key with a different body is refused rather than answered;
//   6. every refusal is its own code, and the tenancy ones are refusals rather
//      than empty successes.
//
// ---------------------------------------------------------------------------
// (3) IS THE ONE THAT NEEDS A REAL RACE, AND IT GETS ONE
//
// Calling the handler twice in sequence proves nothing about concurrency: the
// first call has already settled its reservation before the second starts, so
// the second takes the REPLAY path and the interesting branch — two requests
// in flight at once — is never entered. The failure that costs money is exactly
// the one sequential calls cannot reach: two sockets, two reservations, two
// inserts, two live credentials and one of them unknown to anybody.
//
// `Promise.all` over two `fetch` calls is what makes them race, and the
// assertion is on the DATABASE: `SELECT count(*) FROM "McpToken"` read back by a
// `psql` process INSIDE the container, sharing no pool, driver or transaction
// with the adapter under test. Exactly one row, whatever the two responses say.
//
// ---------------------------------------------------------------------------
// IT FAILS WHEN DOCKER IS ABSENT RATHER THAN SKIPPING. A skipped integration
// suite and a passing one look identical in a CI summary.
//
// ---------------------------------------------------------------------------
// WHY IT LIVES IN `composition/`. C8 in `scripts/arch/composition-root.mjs`
// refuses a suite under `transports/` that reaches the adapters to seed, and it
// refuses it by DIRECTORY so the rule cannot decay into a judgement call. Its
// sibling `identity-rest.integration.test.ts` is here for the same reason.

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
const ORGANIZATION = "cccccccc-0001-4000-8000-000000000001";
const PROJECT = "cccccccc-0002-4000-8000-000000000002";
const ENVIRONMENT = "cccccccc-0003-4000-8000-000000000003";
/** A SECOND project under the SAME organization, and its own environment. It is
 * what makes the forged-pair case a forged PAIR rather than a foreign tenant:
 * the operator may administer both, and the entity still belongs to only one. */
const OTHER_PROJECT = "cccccccc-0007-4000-8000-000000000007";
const OTHER_ENVIRONMENT = "cccccccc-0008-4000-8000-000000000008";
const ENTITY = "cccccccc-0009-4000-8000-000000000009";
const ADMIN = "cccccccc-0004-4000-8000-000000000004";
const OUTSIDER = "cccccccc-0005-4000-8000-000000000005";
const MEMBERSHIP = "cccccccc-0006-4000-8000-000000000006";
/**
 * A REAL MEMBER OF THE ORGANIZATION WHO IS NOT AN ADMIN.
 *
 * The outsider above proves a refusal at gate 2 — no membership at all — and a
 * route asking for `metadata` would refuse them too, so the outsider alone
 * cannot tell the two access levels apart. This member passes gates 1, 2 and 3
 * and is refused ONLY by gate 4, which is the gate that narrows
 * `secret:mutate`. Without this fixture a mint that asked for `metadata` would
 * pass every case in this file.
 */
const MEMBER = "cccccccc-000a-4000-8000-00000000000a";
const MEMBER_MEMBERSHIP = "cccccccc-000b-4000-8000-00000000000b";
/**
 * And the PROJECT membership gate 3 requires of anyone who is not an
 * organization admin. Its role is EDITOR, which gate 4 refuses exactly as it
 * refuses a VIEWER — `roles.ts` records that the two are byte-identical today
 * and that separating them is a product decision with a migration.
 */
const MEMBER_PROJECT_MEMBERSHIP = "cccccccc-000c-4000-8000-00000000000c";

const ADMIN_TOKEN = "win268-p1-admin-session-token";
const OUTSIDER_TOKEN = "win268-p1-outsider-session-token";
const MEMBER_TOKEN = "win268-p1-member-session-token";
const IMPERSONATION_TOKEN = "win268-p1-impersonation-session-token";

const PLATFORM_MINT = "/mcp/platform/tokens";
const ENTITY_MINT = `/mcp/entity/${ENTITY}/tokens`;

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

/**
 * A GET, for the ONE route this suite reads rather than writes.
 *
 * `GET /api/v1/environments/:id/end-users` asks tenancy for `metadata`, which is
 * what makes it the control the mint cases need: an operator who can reach it
 * and cannot mint is an operator gate 4 refused, and nothing weaker than a
 * second route at a DIFFERENT access level can show that over the wire.
 */
async function read(path: string, token: string): Promise<Answer> {
  const response = await fetch(`${base}${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
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

const END_USERS = `${API_VERSION_PREFIX}/environments/${ENVIRONMENT}/end-users`;

function errorCode(answer: Answer): string {
  const error = answer.body["error"] as Record<string, unknown> | undefined;
  return typeof error?.["code"] === "string"
    ? (error["code"] as string)
    : `(no error: ${answer.text.slice(0, 160)})`;
}

function minted(answer: Answer): Record<string, unknown> {
  return (answer.body["data"] ?? {}) as Record<string, unknown>;
}

/** A body the platform mint accepts, with a distinct label per case. */
function platformBody(label: string): Record<string, unknown> {
  return {
    environmentId: ENVIRONMENT,
    name: label,
    permissions: ["agents.list"],
    tier: "scope",
  };
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

  const platform = loadPlatformConfiguration({
    PLATOS_ENVIRONMENT: "test",
    PLATOS_CORE_API_PORT: "0",
    PLATOS_STORE_POSTGRES_URL: databaseUrl,
    // THE IDEMPOTENCY STORE IS REAL AND IS THE POINT. With no Redis the gate
    // fails closed on every keyed request, and this suite would be measuring
    // that refusal instead of the contract.
    PLATOS_STORE_REDIS_URL: redis.getConnectionUrl(),
    PLATOS_PROVIDERS_DEFAULT_MODEL: "anthropic:claude-haiku-4-5-20251001",
    PLATOS_SECURITY_ENCRYPTION_KEY: "d".repeat(64),
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
      { id: asIdentifier(ORGANIZATION), slug: asIdentifier("win268-p1"), name: "WIN-268 P1", archivedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
    await store.saveProject(
      { id: asIdentifier(PROJECT), organizationId: asIdentifier(ORGANIZATION), slug: asIdentifier("p1-project"), name: "P1 project", archivedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
    await store.saveProject(
      { id: asIdentifier(OTHER_PROJECT), organizationId: asIdentifier(ORGANIZATION), slug: asIdentifier("p1-other"), name: "P1 other project", archivedAt: null, createdAt: AT, updatedAt: AT } as never,
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
    // THE ENTITY BELONGS TO `PROJECT`. `OTHER_ENVIRONMENT` belongs to
    // `OTHER_PROJECT`, so the pair (this entity, that environment) is coherent in
    // every part and wrong as a whole — which is the case the mismatch code
    // exists for and the one a two-tenant fixture would not produce.
    await store.saveEntity(
      { id: asIdentifier(ENTITY), projectId: asIdentifier(PROJECT), externalId: "support-desk", displayName: "Support desk", connectionStatus: "connected", connectionKind: "mcp", mcpUrls: [], allowedOrigins: [], capabilities: [], lastConnectedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
  });
  await store.users.upsertByEmail(asIdentifier("p1-admin@example.test"), asIdentifier(ADMIN));
  await store.users.upsertByEmail(asIdentifier("p1-outsider@example.test"), asIdentifier(OUTSIDER));
  await store.users.upsertByEmail(asIdentifier("p1-member@example.test"), asIdentifier(MEMBER));
  await store.unitOfWork.run(async (transaction) => {
    // OWNER, because gate 4 narrows `secret:mutate` to an organization admin or
    // a project ADMIN. A member who could READ this environment and not mint in
    // it is the distinction the mints ask for and a `metadata` route does not.
    await store.saveOrganizationMembership(
      { id: asIdentifier(MEMBERSHIP), organizationId: asIdentifier(ORGANIZATION), userId: asIdentifier(ADMIN), role: "OWNER", deactivatedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
    // MEMBER, not OWNER, and no project membership at all: gates 1-3 pass and
    // gate 4 refuses. See the constant's own note.
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

  await store.operatorSessions.save(session("cccccccc-1001-4000-8000-000000000001", ADMIN_TOKEN, {}));
  await store.operatorSessions.save(
    session("cccccccc-1002-4000-8000-000000000002", OUTSIDER_TOKEN, { userId: asIdentifier(OUTSIDER) }),
  );
  await store.operatorSessions.save(
    session("cccccccc-1003-4000-8000-000000000003", MEMBER_TOKEN, { userId: asIdentifier(MEMBER) }),
  );
  await store.operatorSessions.save(
    session("cccccccc-1005-4000-8000-000000000005", IMPERSONATION_TOKEN, {
      impersonatedUserId: asIdentifier(OUTSIDER),
    }),
  );
  // `platformOperator` is set as SQL for the reason the sibling suite records:
  // `evaluateImpersonation` refuses unless the actor carries the flag and NO
  // published port writes it.
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

describe("WIN-268 P1 — the two mints are served, and served exactly once", () => {
  it("is not vacuous: the contexts AND the idempotency store are composed", () => {
    // Every case below would be meaningless against an uncomposed process: the
    // routes would answer `TRANSPORT_CONTEXT_UNAVAILABLE` and a suite that only
    // checked "not 200" would report green having proven nothing. And without
    // the idempotency store every keyed request is refused fail-closed, so the
    // race case would be measuring the refusal rather than the contract.
    expect(running.app.contexts.identityAccess?.name).toBe("identity-access");
    expect(running.app.contexts.tenancy?.name).toBe("tenancy");
    expect(running.app.requestIdempotency).not.toBeNull();
  });

  it("refuses a keyless mint before it executes, and writes nothing", async () => {
    const before = await observe(`SELECT count(*) FROM "McpToken"`);
    const answer = await call(PLATFORM_MINT, { token: ADMIN_TOKEN, body: platformBody("keyless") });
    expect(answer.status).toBe(committedStatus("IDEMPOTENCY_KEY_REQUIRED"));
    expect(errorCode(answer)).toBe("IDEMPOTENCY_KEY_REQUIRED");
    // THE HALF THAT MATTERS. A gate that refused AFTER the handler ran would
    // return the same code and leave a live credential behind it.
    expect(await observe(`SELECT count(*) FROM "McpToken"`)).toEqual(before);
  });

  it("mints a platform token and stores only its digest", async () => {
    const answer = await call(PLATFORM_MINT, {
      token: ADMIN_TOKEN,
      key: "win268-p1-happy",
      body: platformBody("CI deploy key"),
    });
    expect(answer.status, answer.text).toBe(201);
    const data = minted(answer);
    const secret = data["token"];
    expect(typeof secret).toBe("string");
    expect(String(secret).startsWith("plt_mcp_")).toBe(true);
    expect(data["label"]).toBe("CI deploy key");
    expect(data["tier"]).toBe("scope");

    // THE ROW, READ BY A SEPARATE PROCESS. The digest is what is stored; the
    // secret is not in the row under any column, which is the property the
    // whole `Idempotency-Key: required` contract exists to protect.
    const rows = await observe(
      `SELECT "tokenHash", "environmentId", "name", "tier", "mintedByUserId" FROM "McpToken" WHERE "name" = 'CI deploy key'`,
    );
    expect(rows).toHaveLength(1);
    const [tokenHash, environmentId, name, tier, mintedBy] = String(rows[0]).split("|");
    expect(tokenHash).not.toBe(secret);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    // THE ENVIRONMENT IS THE ONE TENANCY RE-DERIVED, not the string in the body
    // — they agree here, and the forged-pair case below is where they would not.
    expect(environmentId).toBe(ENVIRONMENT);
    expect(name).toBe("CI deploy key");
    expect(tier).toBe("scope");
    expect(mintedBy).toBe(ADMIN);
  });

  it("REPLAYS the same secret for a repeat of a settled request", async () => {
    const body = platformBody("replayed key");
    const first = await call(PLATFORM_MINT, { token: ADMIN_TOKEN, key: "win268-p1-replay", body });
    expect(first.status, first.text).toBe(201);
    const second = await call(PLATFORM_MINT, { token: ADMIN_TOKEN, key: "win268-p1-replay", body });

    // M0.4 §2: "replay returns same secret + `Idempotency-Replayed:true`".
    expect(second.status).toBe(first.status);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();
    expect(second.text).toBe(first.text);
    expect(minted(second)["token"]).toBe(minted(first)["token"]);
    // ONE ROW. The replay did not run the mint again.
    expect(await observe(`SELECT count(*) FROM "McpToken" WHERE "name" = 'replayed key'`)).toEqual(["1"]);
  });

  it("refuses the SAME key with a DIFFERENT request rather than answering it", async () => {
    const key = "win268-p1-mismatch";
    const first = await call(PLATFORM_MINT, { token: ADMIN_TOKEN, key, body: platformBody("mismatch a") });
    expect(first.status, first.text).toBe(201);
    const second = await call(PLATFORM_MINT, { token: ADMIN_TOKEN, key, body: platformBody("mismatch b") });
    // WITHOUT THIS THE KEY WOULD BE A CACHE. A client that reused a key for a
    // different mint would be handed the FIRST mint's secret and believe it had
    // minted the second.
    expect(errorCode(second)).toBe("IDEMPOTENCY_REQUEST_MISMATCH");
    expect(second.status).toBe(committedStatus("IDEMPOTENCY_REQUEST_MISMATCH"));
    expect(await observe(`SELECT count(*) FROM "McpToken" WHERE "name" = 'mismatch b'`)).toEqual(["0"]);
  });

  it("RACES two identical requests and leaves one row and one secret", async () => {
    // THE CASE THIS SUITE EXISTS FOR. Two sockets, one key, one body, both in
    // flight at once — not two sequential calls, which take the replay path and
    // never enter the branch that matters.
    const key = "win268-p1-race";
    const body = platformBody("raced key");
    const [left, right] = await Promise.all([
      call(PLATFORM_MINT, { token: ADMIN_TOKEN, key, body }),
      call(PLATFORM_MINT, { token: ADMIN_TOKEN, key, body }),
    ]);

    const answers = [left, right];
    const created = answers.filter((answer) => answer.status === 201);
    const refused = answers.filter((answer) => answer.status !== 201);

    // EXACTLY ONE EXECUTED. The loser is either told its twin is in flight, or —
    // if the winner settled first — handed the winner's recorded response. Both
    // are correct answers to the same question and BOTH are enumerated, because
    // pinning one of the two would make this case flaky rather than strict.
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const loser = refused[0] as Answer;
    if (loser.headers.get("Idempotency-Replayed") === "true") {
      expect(loser.text).toBe((created[0] as Answer).text);
    } else {
      expect(errorCode(loser)).toBe("IDEMPOTENCY_REQUEST_IN_FLIGHT");
      expect(loser.status).toBe(committedStatus("IDEMPOTENCY_REQUEST_IN_FLIGHT"));
    }

    // AND THE DATABASE IS THE VERDICT. Whatever the two responses said, there is
    // ONE credential — read by a `psql` process that shares no pool, driver or
    // transaction with the adapter that wrote it.
    expect(await observe(`SELECT count(*) FROM "McpToken" WHERE "name" = 'raced key'`)).toEqual(["1"]);
    // NOT VACUOUS: the one that ran really did hand back a usable secret.
    expect(String(minted(created[0] as Answer)["token"]).startsWith("plt_mcp_")).toBe(true);
  });

  it("mints an entity token bounded by the environment, acting as the entity's own principal", async () => {
    const answer = await call(ENTITY_MINT, {
      token: ADMIN_TOKEN,
      key: "win268-p1-entity",
      body: { environmentId: ENVIRONMENT, label: "desk PAT" },
    });
    expect(answer.status, answer.text).toBe(201);
    const data = minted(answer);
    // A DIFFERENT PREFIX FROM THE PLATFORM MINT. `classifyToken` routes a
    // presented secret to a store by its prefix, so a shared one would send an
    // entity token to the platform table and it would never verify.
    expect(String(data["token"]).startsWith("plt_ent_")).toBe(true);
    // The tier column does not exist on this table, so the view reports null
    // rather than inventing one.
    expect(data["tier"]).toBeNull();

    const rows = await observe(
      `SELECT "entityId", "environmentId", "createdByUserId", "mcpUserId", array_to_string("scopes", ',') FROM "McpBearerToken" WHERE "label" = 'desk PAT'`,
    );
    expect(rows).toHaveLength(1);
    const [entityId, environmentId, createdBy, mcpUserId, scopes] = String(rows[0]).split("|");
    expect(entityId).toBe(ENTITY);
    expect(environmentId).toBe(ENVIRONMENT);
    // THE TWO ACTORS ARE DIFFERENT VALUES, which is the whole reason this table
    // has two columns: the operator ISSUED it, and it ACTS AS an end user of the
    // entity who has no Platos account.
    expect(createdBy).toBe(ADMIN);
    expect(mcpUserId).toBe(`mcp:pat:${String(data["tokenId"])}`);
    expect(mcpUserId).not.toBe(ADMIN);
    // The oracle's default scope set, applied because the caller named none.
    expect(scopes).toBe("mcp:tools");
  });

  it("refuses an entity and an environment that do not share a project", async () => {
    // THE FORGED PAIR. Every part is legitimate — the operator owns the whole
    // organization, the entity exists, the environment exists — and the PAIR is
    // wrong. A two-tenant fixture would pass this either way, because its
    // foreign scope would be coherent.
    const answer = await call(ENTITY_MINT, {
      token: ADMIN_TOKEN,
      key: "win268-p1-forged-pair",
      body: { environmentId: OTHER_ENVIRONMENT, label: "forged pair" },
    });
    expect(errorCode(answer)).toBe("MCP_ENTITY_ENVIRONMENT_MISMATCH");
    expect(answer.status).toBe(committedStatus("MCP_ENTITY_ENVIRONMENT_MISMATCH"));
    // ITS OWN CODE, and not the tenancy refusal: the operator MAY administer
    // that environment, so `TENANCY_ENVIRONMENT_FORBIDDEN` would send them to
    // check memberships that are already correct.
    expect(errorCode(answer)).not.toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
    expect(await observe(`SELECT count(*) FROM "McpBearerToken" WHERE "label" = 'forged pair'`)).toEqual(["0"]);
  });

  it("refuses an operator with no membership, as a REFUSAL and not an empty success", async () => {
    const answer = await call(PLATFORM_MINT, {
      token: OUTSIDER_TOKEN,
      key: "win268-p1-outsider",
      body: platformBody("outsider key"),
    });
    expect(errorCode(answer)).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
    expect(answer.status).toBe(committedStatus("TENANCY_ENVIRONMENT_FORBIDDEN"));
    expect(await observe(`SELECT count(*) FROM "McpToken" WHERE "name" = 'outsider key'`)).toEqual(["0"]);
    // REFUSED TWO GATES EARLIER than the member above, and the same control
    // shows it: this operator holds no membership at all, so even the `metadata`
    // route refuses them. The pair — one operator readable and unable to mint,
    // one operator neither — is what separates the two access levels.
    const readable = await read(END_USERS, OUTSIDER_TOKEN);
    expect(errorCode(readable)).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
  });

  it("refuses an ORGANIZATION MEMBER at gate 4, and names a DIFFERENT gate than the outsider", async () => {
    // THE CASE THAT SEPARATES `secret:mutate` FROM `metadata`. This operator is
    // a real, active member of the organization that owns the environment: they
    // pass gate 1 (the environment exists and is unarchived), gate 2 (they hold
    // an active organization membership) and gate 3 (they hold no conflicting
    // project membership). A route that asked for `metadata` would let them
    // through, and they would walk away with a ninety-day credential.
    const answer = await call(PLATFORM_MINT, {
      token: MEMBER_TOKEN,
      key: "win268-p1-member",
      body: platformBody("member key"),
    });
    expect(errorCode(answer)).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
    expect(answer.status).toBe(committedStatus("TENANCY_ENVIRONMENT_FORBIDDEN"));
    expect(await observe(`SELECT count(*) FROM "McpToken" WHERE "name" = 'member key'`)).toEqual(["0"]);

    // AND THE HALF THAT MAKES IT A GATE-4 REFUSAL RATHER THAN JUST A REFUSAL.
    // The SAME operator reaches a `metadata` route on the SAME environment and
    // is answered, so gates 1, 2 and 3 all passed for them. The refusal above is
    // therefore the one gate `secret:mutate` narrows, and a mint that had asked
    // for `metadata` would answer 201 here instead.
    //
    // `details.gate` names the gate, and it is NOT on the wire: M0.4 §2's error
    // envelope has no `details`, and `tenancy` records that its gate detail is
    // log-only. Two routes at two access levels is what the envelope leaves a
    // test to prove — and it is a better proof, because it is the difference a
    // CLIENT can observe.
    const readable = await read(END_USERS, MEMBER_TOKEN);
    expect(readable.status, readable.text).toBe(200);
  });

  it("refuses a mint from an IMPERSONATED session under its own code", async () => {
    // The credential would outlive the impersonation session, and `McpToken`'s
    // single actor column cannot record both the operator and the account they
    // are borrowing. Neither context can see that the session is impersonated by
    // the time the mint runs, so the refusal is the transport's.
    const answer = await call(PLATFORM_MINT, {
      token: IMPERSONATION_TOKEN,
      key: "win268-p1-impersonating",
      body: platformBody("impersonated key"),
    });
    expect(errorCode(answer)).toBe("MCP_TOKEN_MINT_WHILE_IMPERSONATING");
    expect(answer.status).toBe(committedStatus("MCP_TOKEN_MINT_WHILE_IMPERSONATING"));
    expect(await observe(`SELECT count(*) FROM "McpToken" WHERE "name" = 'impersonated key'`)).toEqual(["0"]);
  });

  it("refuses an unauthenticated mint, and never reaches the store", async () => {
    const answer = await call(PLATFORM_MINT, {
      key: "win268-p1-anonymous",
      body: platformBody("anonymous key"),
    });
    expect(errorCode(answer)).toBe("UNAUTHENTICATED");
    expect(answer.status).toBe(committedStatus("UNAUTHENTICATED"));
    expect(await observe(`SELECT count(*) FROM "McpToken" WHERE "name" = 'anonymous key'`)).toEqual(["0"]);
  });

  it("reports every bad field of a body at once, with names a client can act on", async () => {
    const answer = await call(PLATFORM_MINT, {
      token: ADMIN_TOKEN,
      key: "win268-p1-invalid",
      body: { name: "", permissions: [], tier: "superuser" },
    });
    expect(errorCode(answer)).toBe("TRANSPORT_REQUEST_INVALID");
    const fields = ((answer.body["error"] as Record<string, unknown>)["fields"] ??
      []) as readonly { readonly field: string }[];
    // ALL FOUR, NOT THE FIRST. A validator that returned on the first mistake
    // would make a caller with four take four round trips to find them.
    expect(fields.map((violation) => violation.field).sort()).toEqual([
      "body.environmentId",
      "body.name",
      "body.permissions",
      "body.tier",
    ]);
  });
});
