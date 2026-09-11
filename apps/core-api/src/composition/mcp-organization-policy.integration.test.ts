// THE TIER-2 MCP POLICY SURFACE, OVER HTTP, AGAINST A REAL TREE — AND THE FORGED
// SCOPE TRIPLE THAT SEPARATES A TENANCY PROOF FROM A TWO-TENANT ONE.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE HAS TO PROVE, AND WHY IT EXISTS AT ALL
//
// WIN-268 (M4.2) DELETED `listOrgPolicies`, `upsertOrgPolicy` and `deleteOrgPolicy`
// from `apps/agent/src/mcp-platform/permission-gateway.service.ts` — six ORM sites
// over `OrganizationMcpPolicy` that nothing called — and moved the capability onto
// `ToolsContract`, served by `transports/mcp/organization-policies.controller.ts`.
// Two cases went with them:
// `permission-gateway-forged-scope.integration.test.ts` proved that those three
// helpers refused a forged organization/project/environment chain, and that they
// did it BEFORE writing anything.
//
// A guarantee that is deleted along with its implementation has not been kept. So
// this suite asks the SAME question of the new path, and it has to ask it harder,
// because the new path refuses in a different place: the legacy helpers re-derived
// the owning organization from the `Environment` row on every call, and the
// contract never sees a caller-supplied triple at all.
//
// ---------------------------------------------------------------------------
// A TWO-TENANT TEST IS NOT AUTOMATICALLY A TENANCY TEST
//
// Give the surface tenant beta's COHERENT scope and the guarded code and the
// unguarded code answer identically — beta genuinely has no policy for that
// pattern, so an empty listing is correct either way. The case below named
// "A COHERENT FOREIGN SCOPE PROVES NOTHING" exists to say that out loud rather
// than to be evidence.
//
// THE CASE THAT TELLS THEM APART IS THE FORGED TRIPLE:
// `{ organizationId: beta.org, projectId: alpha.project, environmentId: alpha.env }`
// — three ids that are each real and that do not form a chain. It is proved TWICE,
// at two independent layers, because on this path the two layers fail for
// different reasons:
//
//   LAYER 1, THE MINT REGISTER. `withOperator` asks
//   `TenancyContract.verifyAuthorization`, whose implementation is a WeakSet of the
//   objects tenancy itself minted plus an `Object.isFrozen` check. A forged triple
//   therefore cannot even be OFFERED as an authorization: the refusal is
//   `TENANCY_AUTHORIZATION_FORGED` and it lands before a row is read. The case
//   below also forges a FROZEN STRUCTURAL COPY of a genuine grant with its scope
//   swapped — the mutation a shape check would pass and identity will not.
//
//   LAYER 2, THE STORE. `requireScope` in
//   `packages/adapters/postgres-tenancy/src/tools-scope.ts` resolves the
//   environment THROUGH its project to its organization in one statement on the
//   front of every scoped method, and mints TWO distinct reasons —
//   `out_of_scope` and `unknown_environment` — where the legacy service minted
//   three. It is asked directly, through the repository the composition assembled,
//   because no transport can reach it with a forged triple: every contract method
//   that takes a scope derives one from an authorization the register vouched for.
//   THAT IS DEFENCE IN DEPTH AND THE INNER LAYER IS TESTED ON ITS OWN TERMS RATHER
//   THAN THROUGH A PATH THAT CANNOT REACH IT.
//
// ---------------------------------------------------------------------------
// FOUR DISTINCT REFUSAL CODES, ONE PER GUARD
//
//   TENANCY_ENVIRONMENT_FORBIDDEN   403  the four gates. `details.gate` names WHICH,
//                                        and two cases below read two different
//                                        gates off it — `organization-membership`
//                                        for a foreign operator and
//                                        `secret-mutate-role` for a real member who
//                                        may read and may not write.
//   TENANCY_AUTHORIZATION_FORGED    403  a value the mint register does not hold.
//   TOOLS_REPOSITORY_UNAVAILABLE    503  the store refused the scope, with
//                                        `details.reason` separating a forged chain
//                                        from an environment that is not one.
//   TOOLS_POLICY_EFFECT_UNSUPPORTED 400  `require_approval` on a two-valued column,
//                                        refused rather than rounded.
//
// Two guards answering the same code cannot be told apart in an audit line, which
// is why each is asserted by CODE and, where the code is shared, by the field that
// separates its causes.
//
// ---------------------------------------------------------------------------
// IT RUNS AGAINST A CONTAINER *OR* AGAINST A DATABASE SOMEBODY ELSE STARTED, AND
// IT NEVER SKIPS
//
// Its four siblings in this directory start a `PostgreSqlContainer` and fail when
// Docker is absent, on the stated ground that a skipped integration suite and a
// passing one look identical in a CI summary. That is right and it makes them
// unrunnable on a machine where Docker may not run at all — so this one takes an
// EXTERNAL url when `PLATOS_POSTGRES_INTEGRATION_DATABASE_URL` names one and
// starts a container when it does not. Both paths run every case; neither skips.
// The url is the same variable `scripts/agent-tenancy-postgres-integration.mjs`
// already requires, so a job that has one has one for this file too.
//
// REDIS IS A BINDING HERE AND NOT A DEPENDENCY OF ANY PATH UNDER TEST, WHICH IS
// WHY EXTERNAL MODE MAY POINT AT A PORT NOBODY IS LISTENING ON.
//
// `tools` composes only over four peers, and two of them need a redis-backed
// adapter to ASSEMBLE: `identity-access` names `redis-ratelimit (RateLimiter)` and
// `providers` names `redis-cache (ProviderProbeCache)`. So a process with no
// `PLATOS_STORE_REDIS_URL` at all leaves `tools` uncomposed and every route below
// would answer `TRANSPORT_CONTEXT_UNAVAILABLE` — the suite would be measuring the
// 503 and calling it a policy contract.
//
// The client connects LAZILY, so a url is enough to assemble the binding, and
// nothing on these three routes performs a redis operation: an operator session is
// authenticated against `OperatorSession` in PostgreSQL, the four gates read
// memberships in PostgreSQL, and the policy rows are PostgreSQL. That claim is not
// a comment — IT IS WHAT MAKES THE SUITE PASS. A path that did a round trip
// against `REDIS_DEAD_URL` would time out here and the case would go red, so every
// green run is the evidence. `PLATOS_REDIS_INTEGRATION_URL` overrides it for a
// runner that has a real one.
//
// The same claim, from the other direction: `http/idempotency-policy.ts` classes an
// unlisted operation `accepted` — a key is honoured if sent and not demanded — and
// the first case below reads `classifyRequest` for all three of this surface's
// templates and fails if any is `required`. A `required` template would be refused
// before routing without a live store, so that assertion is what keeps this
// arrangement from silently becoming a measurement of the idempotency gate.
//
// ---------------------------------------------------------------------------
// WHY IT LIVES IN `composition/`. C8 in `scripts/arch/composition-root.mjs`
// refuses a suite under `transports/` that reaches the adapters to seed, by
// DIRECTORY so the rule cannot decay into a judgement call. Its four siblings are
// here for the same reason.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { psqlConnectionUrl, psqlRows } from "./integration-database.js";

import { asIdentifier } from "@platos/kernel";
import type { EnvironmentScope } from "@platos/kernel";
import type { OrganizationMcpPolicyId, ToolsContract } from "@platos/context-tools";
import type { UserId } from "@platos/context-tenancy";

import { loadPlatformConfiguration } from "../config/platform.js";
import { classifyRequest } from "../http/idempotency-policy.js";
import { createProcessDefaults, startCoreApi, type RunningCoreApi } from "../runtime/lifecycle.js";
import { constructAdapters, type AdapterConstruction } from "./adapter-bindings.js";
import { assembleContextPorts } from "./context-ports.js";

/** The one instant every fixture row is stamped with, so nothing is time-dependent. */
const AT = new Date("2026-05-01T09:00:00.000Z");

/** Tenant ALPHA — the one that writes a policy. */
const ALPHA_ORGANIZATION = "dddddddd-0001-4000-8000-000000000001";
const ALPHA_PROJECT = "dddddddd-0002-4000-8000-000000000002";
const ALPHA_ENVIRONMENT = "dddddddd-0003-4000-8000-000000000003";
const ALPHA_OWNER = "dddddddd-0004-4000-8000-000000000004";
const ALPHA_MEMBERSHIP = "dddddddd-0005-4000-8000-000000000005";

/**
 * Tenant BETA — a SEPARATE organization with its own owner, project and
 * environment.
 *
 * A second PROJECT under alpha would not do: the tier-2 row is keyed by
 * ORGANIZATION, so a forged pair inside one organization would name the same
 * policy set and could not be told from the coherent one.
 */
const BETA_ORGANIZATION = "dddddddd-0011-4000-8000-000000000011";
const BETA_PROJECT = "dddddddd-0012-4000-8000-000000000012";
const BETA_ENVIRONMENT = "dddddddd-0013-4000-8000-000000000013";
const BETA_OWNER = "dddddddd-0014-4000-8000-000000000014";
const BETA_MEMBERSHIP = "dddddddd-0015-4000-8000-000000000015";

/**
 * A REAL MEMBER OF ALPHA WHO MAY READ AND MAY NOT WRITE.
 *
 * Beta's owner proves a refusal at gate 2 — no membership in alpha at all — and a
 * route asking for `metadata` would refuse them too, so beta alone cannot tell the
 * two access levels apart. This member passes gates 1, 2 and 3 and is refused ONLY
 * by gate 4, which is the gate that narrows `secret:mutate`. Without this fixture a
 * `PUT` that asked for `metadata` would pass every case in this file.
 */
const ALPHA_EDITOR = "dddddddd-0021-4000-8000-000000000021";
const ALPHA_EDITOR_MEMBERSHIP = "dddddddd-0022-4000-8000-000000000022";
const ALPHA_EDITOR_PROJECT_MEMBERSHIP = "dddddddd-0023-4000-8000-000000000023";

const ALPHA_OWNER_TOKEN = "win268-policy-alpha-owner-session";
const BETA_OWNER_TOKEN = "win268-policy-beta-owner-session";
const ALPHA_EDITOR_TOKEN = "win268-policy-alpha-editor-session";

/** The pattern alpha writes. Distinct per tenant so a leak is visible by name. */
const ALPHA_PATTERN = "threads.*";

const POLICIES = (environmentId: string): string =>
  `/mcp/platform/environments/${environmentId}/policies`;

let postgres: StartedPostgreSqlContainer | null = null;
let construction: AdapterConstruction;
let running: RunningCoreApi;
let base: string;
let tools: ToolsContract;
let repository: {
  listOrganizationPolicies(
    scope: EnvironmentScope,
  ): Promise<{ readonly ok: boolean; readonly error?: unknown }>;
};
/** How a second reader talks to the database. See `observe`. */
let observeWith: (sql: string) => Promise<readonly string[]>;

/**
 * The ambient environment, copied and frozen ONCE. `scripts/arch/env-access.mjs`
 * counts READS, and this suite legitimately needs four values from the machine it
 * runs on — so it takes the same shape `apps/core-api/src/config/environment.ts`
 * takes for the whole deployable: one read at module load, frozen, and every
 * consumer below indexes an ordinary value. Four reads would be a four-panel door
 * in a gate whose entire argument is that there should be one.
 *
 * WHY THIS SUITE READS THE ENVIRONMENT AT ALL, when its four siblings read it only
 * to hand PATH to a spawned CLI: WHICH DATABASE TO USE IS THE RUNNER'S DECISION
 * AND NOT A FIXTURE'S. A suite that could only start a container could not run on a
 * machine where Docker may not run, and one that hard-coded a url would be a
 * fixture asserting where somebody else's PostgreSQL lives.
 */
const AMBIENT: Readonly<Record<string, string | undefined>> = Object.freeze({ ...process.env });

/** The external database this run was pointed at, or null when it started one. */
const externalDatabaseUrl = AMBIENT["PLATOS_POSTGRES_INTEGRATION_DATABASE_URL"] ?? null;

/**
 * A redis url for a port this suite deliberately leaves closed. See the banner.
 *
 * Port 1 is unbindable without privileges on every platform this repository runs
 * on, so it cannot accidentally be a real server somebody else started — which a
 * high, plausible-looking port could be, and then a path that DID reach redis would
 * quietly succeed and the banner's claim would stop being tested.
 */
const REDIS_DEAD_URL = "redis://127.0.0.1:1";

function packageRootRelative(...parts: string[]): string {
  return resolve(process.cwd(), ...parts);
}

/**
 * Read rows back through a `psql` PROCESS, not through the adapter under test.
 *
 * Durability is not "the writer can see its own row" — a writer sees its own
 * uncommitted work — it is "somebody else can see it". This shares no pool, no
 * driver and no transaction with the code that wrote it.
 */
async function observe(sql: string): Promise<readonly string[]> {
  return observeWith(sql);
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly text: string;
}

async function call(
  method: "GET" | "PUT" | "DELETE",
  path: string,
  options: { readonly token?: string; readonly body?: unknown } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
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
  return { status: response.status, body, text };
}

function errorOf(answer: Answer): Record<string, unknown> {
  return (answer.body["error"] ?? {}) as Record<string, unknown>;
}

function errorCode(answer: Answer): string {
  const code = errorOf(answer)["code"];
  return typeof code === "string" ? code : `(no error: ${answer.text.slice(0, 200)})`;
}

function rows(answer: Answer): readonly Record<string, unknown>[] {
  return (answer.body["data"] ?? []) as readonly Record<string, unknown>[];
}

function item(answer: Answer): Record<string, unknown> {
  return (answer.body["data"] ?? {}) as Record<string, unknown>;
}

/** A scope triple, as the store's port takes one. */
function scopeOf(organizationId: string, projectId: string, environmentId: string): EnvironmentScope {
  return {
    organizationId: asIdentifier(organizationId),
    projectId: asIdentifier(projectId),
    environmentId: asIdentifier(environmentId),
  } as EnvironmentScope;
}

/** `details.reason` off a `TOOLS_REPOSITORY_UNAVAILABLE`, or a message naming what came instead. */
function storeReason(result: { readonly ok: boolean; readonly error?: unknown }): string {
  if (result.ok) return "(the store did not refuse)";
  const error = result.error as { readonly code?: string; readonly details?: Record<string, unknown> };
  const reason = error.details?.["reason"];
  return typeof reason === "string" ? reason : `(${String(error.code)} carried no reason)`;
}

beforeAll(async () => {
  let databaseUrl: string;
  if (externalDatabaseUrl === null) {
    postgres = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    databaseUrl = postgres.getConnectionUri();
    observeWith = async (sql) => {
      const result = await postgres!.exec([
        "psql", "-U", postgres!.getUsername(), "-d", postgres!.getDatabase(),
        "-t", "-A", "-F", "|", "-c", sql,
      ]);
      if (result.exitCode !== 0) throw new Error(`psql refused: ${result.output}`);
      return result.output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    };
  } else {
    databaseUrl = externalDatabaseUrl;
    // `PLATOS_PSQL_BINARY` because a Homebrew `postgresql@17` is not on `PATH` by
    // default and a bare `psql` would fail with ENOENT — which reads as "the row
    // is missing" if the caller is not careful. Named, so the failure is about the
    // binary.
    const psql = AMBIENT["PLATOS_PSQL_BINARY"] ?? "psql";
    observeWith = async (sql) =>
      psqlRows(
        // TRANSLATED, NOT PASSED THROUGH. The supplied url is a PRISMA url and the
        // canonical one in `ci.yml` ends `?schema=public`, which `psql` refuses
        // outright — "invalid URI query parameter". Before this call translated it,
        // this suite was 5 passed / 5 failed against the repository's own url, and
        // every failure read as a missing row. See `integration-database.ts`.
        execFileSync(psql, ["-d", psqlConnectionUrl(databaseUrl), "-t", "-A", "-F", "|", "-c", sql], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
  }

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
    PLATOS_STORE_REDIS_URL: AMBIENT["PLATOS_REDIS_INTEGRATION_URL"] ?? REDIS_DEAD_URL,
    PLATOS_PROVIDERS_DEFAULT_MODEL: "anthropic:claude-haiku-4-5-20251001",
    PLATOS_SECURITY_ENCRYPTION_KEY: "e".repeat(64),
    PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "4",
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
  const toolsPorts = assembly.ports.tools;
  if (toolsPorts === undefined) throw new Error("tools' ports must be assembled");
  repository = toolsPorts.repository as unknown as typeof repository;

  // SEEDED THROUGH THE ADAPTER'S OWN PORTS, never as SQL: a fixture that wrote
  // these rows directly would be skipping the store under test.
  await store.unitOfWork.run(async (transaction) => {
    for (const [organizationId, slug, name] of [
      [ALPHA_ORGANIZATION, "win268-policy-alpha", "Alpha"],
      [BETA_ORGANIZATION, "win268-policy-beta", "Beta"],
    ] as const) {
      await store.saveOrganization(
        { id: asIdentifier(organizationId), slug: asIdentifier(slug), name, archivedAt: null, createdAt: AT, updatedAt: AT } as never,
        transaction,
      );
    }
    for (const [projectId, organizationId, slug, name] of [
      [ALPHA_PROJECT, ALPHA_ORGANIZATION, "alpha-project", "Alpha project"],
      [BETA_PROJECT, BETA_ORGANIZATION, "beta-project", "Beta project"],
    ] as const) {
      await store.saveProject(
        { id: asIdentifier(projectId), organizationId: asIdentifier(organizationId), slug: asIdentifier(slug), name, archivedAt: null, createdAt: AT, updatedAt: AT } as never,
        transaction,
      );
    }
    for (const [environmentId, projectId, name] of [
      [ALPHA_ENVIRONMENT, ALPHA_PROJECT, "Alpha production"],
      [BETA_ENVIRONMENT, BETA_PROJECT, "Beta production"],
    ] as const) {
      await store.saveEnvironment(
        { id: asIdentifier(environmentId), projectId: asIdentifier(projectId), slug: asIdentifier("prod"), name, archivedAt: null, accessKeyRevocationVersion: 0, memoryFeedbackBackfillCursor: null, memoryFeedbackBackfillCompletedAt: null, createdAt: AT, updatedAt: AT } as never,
        transaction,
      );
    }
  });

  await store.users.upsertByEmail(asIdentifier("win268-alpha-owner@example.test"), asIdentifier(ALPHA_OWNER));
  await store.users.upsertByEmail(asIdentifier("win268-beta-owner@example.test"), asIdentifier(BETA_OWNER));
  await store.users.upsertByEmail(asIdentifier("win268-alpha-editor@example.test"), asIdentifier(ALPHA_EDITOR));

  await store.unitOfWork.run(async (transaction) => {
    // OWNER, because gate 4 narrows `secret:mutate` to an organization admin or a
    // project ADMIN.
    for (const [membershipId, organizationId, userId, role] of [
      [ALPHA_MEMBERSHIP, ALPHA_ORGANIZATION, ALPHA_OWNER, "OWNER"],
      [BETA_MEMBERSHIP, BETA_ORGANIZATION, BETA_OWNER, "OWNER"],
      // MEMBER, not OWNER: gates 1-3 pass and gate 4 refuses. See the constant.
      [ALPHA_EDITOR_MEMBERSHIP, ALPHA_ORGANIZATION, ALPHA_EDITOR, "MEMBER"],
    ] as const) {
      await store.saveOrganizationMembership(
        { id: asIdentifier(membershipId), organizationId: asIdentifier(organizationId), userId: asIdentifier(userId), role, deactivatedAt: null, createdAt: AT, updatedAt: AT } as never,
        transaction,
      );
    }
    // And the PROJECT membership gate 3 requires of anyone who is not an
    // organization admin. EDITOR, which gate 4 refuses exactly as it refuses a
    // VIEWER.
    await store.saveProjectMembership(
      { id: asIdentifier(ALPHA_EDITOR_PROJECT_MEMBERSHIP), projectId: asIdentifier(ALPHA_PROJECT), organizationMembershipId: asIdentifier(ALPHA_EDITOR_MEMBERSHIP), organizationId: asIdentifier(ALPHA_ORGANIZATION), role: "EDITOR", createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
  });

  const session = (id: string, token: string, userId: string): never =>
    ({
      sessionId: asIdentifier(id),
      tokenHash: hasher.hash(token),
      tier: "OPERATOR",
      userId: asIdentifier(userId),
      impersonatedUserId: null,
      parentSessionId: null,
      mfaVerifiedAt: null,
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      revokedAt: null,
      lastSeenAt: null,
      createdAt: AT,
    }) as never;

  await store.operatorSessions.save(session("dddddddd-1001-4000-8000-000000000001", ALPHA_OWNER_TOKEN, ALPHA_OWNER));
  await store.operatorSessions.save(session("dddddddd-1002-4000-8000-000000000002", BETA_OWNER_TOKEN, BETA_OWNER));
  await store.operatorSessions.save(session("dddddddd-1003-4000-8000-000000000003", ALPHA_EDITOR_TOKEN, ALPHA_EDITOR));

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
  const composed = running.app.contexts.tools;
  if (composed === undefined) throw new Error("tools must be composed for this suite to mean anything");
  tools = composed;
}, 300_000);

afterAll(async () => {
  await running?.stop("suite-teardown");
  await construction?.release();
  if (postgres !== null) await postgres.stop();
  else if (externalDatabaseUrl !== null) {
    // The rows this suite seeded, removed by id. It does NOT drop the schema: the
    // database was somebody else's before this run and is theirs after it.
    for (const table of ["OrganizationMcpPolicy"] as const) {
      await observe(
        `DELETE FROM "${table}" WHERE "organizationId" IN ('${ALPHA_ORGANIZATION}','${BETA_ORGANIZATION}')`,
      );
    }
    await observe(`DELETE FROM "OperatorSession" WHERE "userId" IN ('${ALPHA_OWNER}','${BETA_OWNER}','${ALPHA_EDITOR}')`);
    await observe(`DELETE FROM "Organization" WHERE "id" IN ('${ALPHA_ORGANIZATION}','${BETA_ORGANIZATION}')`);
    await observe(`DELETE FROM "User" WHERE "id" IN ('${ALPHA_OWNER}','${BETA_OWNER}','${ALPHA_EDITOR}')`);
  }
}, 120_000);

describe("WIN-268 (M4.2) — the tier-2 MCP policy surface on ToolsContract", () => {
  it("NOT VACUOUS: `tools` is composed, and none of the three templates is an idempotency mint", () => {
    // WITHOUT THE FIRST HALF every refusal below could be
    // `TRANSPORT_CONTEXT_UNAVAILABLE` wearing a different name, and the positive
    // controls would be the only thing that failed.
    expect(tools.name).toBe("tools");

    // THE SECOND HALF IS WHY THIS SUITE NEEDS NO REDIS. `classifyRequest` is the
    // function the idempotency gate itself calls; an operation it classes
    // `required` is refused before routing when no key is sent, and would need a
    // real store to be admitted. All three of these are unlisted, which means
    // `accepted` — honoured if sent, never demanded. Asserted rather than assumed,
    // because the day one of them becomes a mint this file must fail rather than
    // measure the gate's refusal and call it a policy answer.
    const template = "/mcp/platform/environments/:environmentId/policies";
    for (const [method, path] of [
      ["GET", template],
      ["PUT", template],
      ["DELETE", `${template}/:policyId`],
    ] as const) {
      expect(classifyRequest(method, path), `${method} ${path}`).not.toBe("required");
    }
  });

  it("POSITIVE CONTROL: alpha's owner writes, lists, deletes — and the row is really in the database", async () => {
    // Without this, "refuse everything" satisfies every case below.
    const written = await call("PUT", POLICIES(ALPHA_ENVIRONMENT), {
      token: ALPHA_OWNER_TOKEN,
      body: { pattern: ALPHA_PATTERN, state: "block" },
    });
    expect(written.body["error"], written.text).toBeUndefined();
    expect(written.status).toBe(200);
    expect(item(written)["pattern"]).toBe(ALPHA_PATTERN);
    expect(item(written)["state"]).toBe("block");
    const policyId = item(written)["policyId"] as string;

    // A SECOND READER, sharing no pool with the adapter that wrote it, and the row
    // is joined to ALPHA's organization by the statement rather than by trust.
    const seen = await observe(
      `SELECT "pattern", "effect" FROM "OrganizationMcpPolicy" WHERE "organizationId" = '${ALPHA_ORGANIZATION}'`,
    );
    expect(seen).toEqual([`${ALPHA_PATTERN}|DENY`]);

    const listed = await call("GET", POLICIES(ALPHA_ENVIRONMENT), { token: ALPHA_OWNER_TOKEN });
    expect(listed.status).toBe(200);
    expect(rows(listed).map((row) => row["pattern"])).toContain(ALPHA_PATTERN);

    // THE PATTERN IS ALPHA'S AND IS NOT VISIBLE TO BETA, whose OWN scope is
    // coherent. This is the read half of the isolation claim; the case below says
    // why it is not by itself a tenancy proof.
    const betaSees = await call("GET", POLICIES(BETA_ENVIRONMENT), { token: BETA_OWNER_TOKEN });
    expect(betaSees.status).toBe(200);
    expect(rows(betaSees)).toEqual([]);

    const deleted = await call("DELETE", `${POLICIES(ALPHA_ENVIRONMENT)}/${policyId}`, {
      token: ALPHA_OWNER_TOKEN,
    });
    expect(deleted.status).toBe(200);
    expect(item(deleted)["deleted"]).toBe(true);

    // AND A SECOND DELETE IS `false` RATHER THAN AN ERROR. `false` means "no such
    // policy in this organization", which is a fact a caller may be told; the
    // refusal a forged scope earns is a different answer entirely, asserted below.
    const again = await call("DELETE", `${POLICIES(ALPHA_ENVIRONMENT)}/${policyId}`, {
      token: ALPHA_OWNER_TOKEN,
    });
    expect(again.status).toBe(200);
    expect(item(again)["deleted"]).toBe(false);
    expect(
      await observe(
        `SELECT "id" FROM "OrganizationMcpPolicy" WHERE "organizationId" = '${ALPHA_ORGANIZATION}'`,
      ),
    ).toEqual([]);
  });

  it("A COHERENT FOREIGN SCOPE PROVES NOTHING, and this case exists to say so", async () => {
    // Beta's owner asking about BETA's own environment is a legitimate request with
    // a legitimate empty answer, and it was the answer before any guard existed.
    // The two-tenant shape on its own is therefore not the test — the forged triple
    // below is.
    const listed = await call("GET", POLICIES(BETA_ENVIRONMENT), { token: BETA_OWNER_TOKEN });
    expect(listed.status).toBe(200);
    expect(rows(listed)).toEqual([]);
  });

  it("BETA'S OWNER IS REFUSED ALPHA'S ENVIRONMENT AT GATE 2, and it is a refusal rather than an empty page", async () => {
    // AN EMPTY PAGE WOULD BE THE DEFECT. A listing whose authorization failed and
    // which answered `200 {"data":[]}` would tell an operator that an organization
    // they cannot see has no policies — indistinguishable, to them and to a support
    // engineer, from one that really has none.
    const listed = await call("GET", POLICIES(ALPHA_ENVIRONMENT), { token: BETA_OWNER_TOKEN });
    expect(listed.status).toBe(403);
    expect(errorCode(listed)).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
    expect(rows(listed)).toEqual([]);

    const written = await call("PUT", POLICIES(ALPHA_ENVIRONMENT), {
      token: BETA_OWNER_TOKEN,
      body: { pattern: "forged.*", state: "block" },
    });
    expect(errorCode(written)).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
    // AND NOTHING WAS WRITTEN — under either organization. A refusal that landed
    // after the write would satisfy the assertion above and still have created the
    // row.
    expect(
      await observe(`SELECT "id" FROM "OrganizationMcpPolicy" WHERE "pattern" = 'forged.*'`),
    ).toEqual([]);
  });

  it("GATE 4: alpha's EDITOR may READ the policy set and may not WRITE it", async () => {
    // THE TWO ACCESS LEVELS, TOLD APART BY WHAT THE WIRE ACTUALLY SHOWS. Beta's
    // owner is refused BOTH ways, so beta alone cannot show that the read asks for
    // `metadata` and the writes ask for `secret:mutate`. This operator passes gates
    // 1, 2 and 3 and is refused only by gate 4 — so the SHAPE of the answer differs
    // per method, which is the observable a route asking for one level everywhere
    // could not produce.
    const listed = await call("GET", POLICIES(ALPHA_ENVIRONMENT), { token: ALPHA_EDITOR_TOKEN });
    expect(listed.status).toBe(200);

    const written = await call("PUT", POLICIES(ALPHA_ENVIRONMENT), {
      token: ALPHA_EDITOR_TOKEN,
      body: { pattern: "editor.*", state: "block" },
    });
    expect(written.status).toBe(403);
    expect(errorCode(written)).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");

    const removed = await call("DELETE", `${POLICIES(ALPHA_ENVIRONMENT)}/${randomUUID()}`, {
      token: ALPHA_EDITOR_TOKEN,
    });
    expect(removed.status).toBe(403);
    expect(errorCode(removed)).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
    expect(
      await observe(`SELECT "id" FROM "OrganizationMcpPolicy" WHERE "pattern" = 'editor.*'`),
    ).toEqual([]);

    // `details` DOES NOT REACH A CALLER, AND THAT IS THE ENVELOPE'S RULE RATHER
    // THAN A GAP. `http/failure.ts`: "`details` — which the kernel calls
    // 'structured context for logs, never returned to a client' — cannot reach a
    // caller by somebody forgetting". So WHICH GATE closed is read in-process, off
    // the same contract the route calls, rather than off a field the transport is
    // required to strip. Without this the two 403s above would be
    // indistinguishable from a fixture whose editor is not a member at all — which
    // would make the 200 a coincidence and this whole case vacuous.
    const tenancy = running.app.contexts.tenancy;
    if (tenancy === undefined) throw new Error("tenancy must be composed");
    // BOTH IDS BRANDED EXPLICITLY. `asIdentifier` with no type argument infers the
    // generic brand, which `tsc -b` refuses at `OperatorPrincipal` — the same
    // narrowing `rest/operator.ts`'s `operatorPrincipal` performs for every route.
    const operator = {
      actorUserId: asIdentifier<UserId>(ALPHA_EDITOR),
      effectiveUserId: asIdentifier<UserId>(ALPHA_EDITOR),
    };
    const mutating = await tenancy.authorizeEnvironmentOperator({
      environmentId: asIdentifier(ALPHA_ENVIRONMENT),
      operator,
      access: "secret:mutate",
    });
    expect(mutating.ok).toBe(false);
    const gate = (
      (mutating as { readonly error: { readonly details?: Record<string, unknown> } }).error
        .details ?? {}
    )["gate"];
    expect(gate).toBe("secret-mutate-role");
    // AND THE SAME OPERATOR AT `metadata` IS GRANTED, which is what makes the gate
    // above the ONE that refused rather than the first of several.
    const reading = await tenancy.authorizeEnvironmentOperator({
      environmentId: asIdentifier(ALPHA_ENVIRONMENT),
      operator,
      access: "metadata",
    });
    expect(reading.ok).toBe(true);
  });

  it("THE FORGED TRIPLE cannot be offered as an authorization: the mint register refuses it", async () => {
    // THE CASE THE LEGACY DEFECT PASSED, asked of the new path. Every id is real.
    // The chain is not: beta's organization over alpha's project and environment.
    const forged = Object.freeze({
      scope: scopeOf(BETA_ORGANIZATION, ALPHA_PROJECT, ALPHA_ENVIRONMENT),
      access: "secret:mutate",
      actorUserId: asIdentifier(ALPHA_OWNER),
      effectiveUserId: asIdentifier(ALPHA_OWNER),
      organizationRole: "OWNER",
      projectRole: "ADMIN",
    });

    const written = await tools.setOrganizationPolicy({
      authorization: forged,
      pattern: "forged-triple.*",
      state: "block",
    });
    expect(written.ok).toBe(false);
    expect((written as { readonly error: { readonly code: string } }).error.code).toBe(
      "TENANCY_AUTHORIZATION_FORGED",
    );

    const listed = await tools.listOrganizationPolicies({ authorization: forged });
    expect((listed as { readonly error: { readonly code: string } }).error.code).toBe(
      "TENANCY_AUTHORIZATION_FORGED",
    );

    const removed = await tools.deleteOrganizationPolicy({
      authorization: forged,
      organizationMcpPolicyId: asIdentifier<OrganizationMcpPolicyId>(randomUUID()),
    });
    expect((removed as { readonly error: { readonly code: string } }).error.code).toBe(
      "TENANCY_AUTHORIZATION_FORGED",
    );

    // AND NOTHING WAS WRITTEN ANYWHERE. The refusal lands before a row is read, so
    // neither organization gained a policy.
    expect(
      await observe(`SELECT "id" FROM "OrganizationMcpPolicy" WHERE "pattern" = 'forged-triple.*'`),
    ).toEqual([]);
  });

  it("A FROZEN STRUCTURAL COPY of a genuine grant is refused too, which a shape check would pass", async () => {
    // THE MUTATION THAT SEPARATES IDENTITY FROM SHAPE. `requireAuthorization` checks
    // a WeakSet of the objects tenancy minted AND `Object.isFrozen`. A copy with
    // beta's organization spliced into an otherwise-genuine alpha grant satisfies
    // every field-level predicate anybody could write and is not the object the
    // register holds. If this assertion ever reads `ok: true`, the guard has become
    // a shape check and the forged triple is live again.
    const genuine = await tools.listOrganizationPolicies({
      authorization: await mintAlphaAuthorization(),
    });
    expect(genuine.ok).toBe(true);

    const grant = await mintAlphaAuthorization();
    const copy = Object.freeze({
      ...(grant as unknown as Record<string, unknown>),
      scope: scopeOf(BETA_ORGANIZATION, ALPHA_PROJECT, ALPHA_ENVIRONMENT),
    });
    const refused = await tools.listOrganizationPolicies({ authorization: copy });
    expect(refused.ok).toBe(false);
    expect((refused as { readonly error: { readonly code: string } }).error.code).toBe(
      "TENANCY_AUTHORIZATION_FORGED",
    );
  });

  it("THE STORE REFUSES A FORGED TRIPLE ON ITS OWN TERMS, with a reason distinct from a missing environment", async () => {
    // DEFENCE IN DEPTH, TESTED WHERE IT LIVES. No transport can reach `requireScope`
    // with a forged triple — every contract method that takes a scope derives one
    // from an authorization the register vouched for — so this asks the repository
    // the composition assembled, directly. The value of the inner layer is that it
    // holds if the outer one is ever bypassed, and a layer nothing exercises is a
    // layer nobody knows the state of.
    const forged = await repository.listOrganizationPolicies(
      scopeOf(BETA_ORGANIZATION, ALPHA_PROJECT, ALPHA_ENVIRONMENT),
    );
    expect(forged.ok).toBe(false);
    expect(storeReason(forged)).toBe("out_of_scope:listOrganizationPolicies");

    // A DIFFERENT CAUSE GETS A DIFFERENT REASON. An operator reading a log must be
    // able to tell a forged ancestry from a deleted environment without reading a
    // message, which is why the adapter mints two names and not one.
    const missing = await repository.listOrganizationPolicies(
      scopeOf(ALPHA_ORGANIZATION, ALPHA_PROJECT, randomUUID()),
    );
    expect(missing.ok).toBe(false);
    expect(storeReason(missing)).toBe("unknown_environment:listOrganizationPolicies");
    expect(storeReason(missing)).not.toBe(storeReason(forged));

    // THE POSITIVE HALF. Without it, "refuse every scope" passes both assertions.
    const coherent = await repository.listOrganizationPolicies(
      scopeOf(ALPHA_ORGANIZATION, ALPHA_PROJECT, ALPHA_ENVIRONMENT),
    );
    expect(coherent.ok).toBe(true);
  });

  it("`require_approval` IS REFUSED RATHER THAN ROUNDED, and a 201-character pattern is the context's judgement", async () => {
    // THE COLUMN IS TWO-VALUED AND THE STATE SPACE IS THREE-VALUED. An operator who
    // wanted "make my organization approve every mutation" is told this tier cannot
    // do it, instead of quietly getting `auto_allow` and believing otherwise.
    const rounded = await call("PUT", POLICIES(ALPHA_ENVIRONMENT), {
      token: ALPHA_OWNER_TOKEN,
      body: { pattern: "approval.*", state: "require_approval" },
    });
    expect(rounded.status).toBe(400);
    expect(errorCode(rounded)).toBe("TOOLS_POLICY_EFFECT_UNSUPPORTED");
    expect(
      await observe(`SELECT "id" FROM "OrganizationMcpPolicy" WHERE "pattern" = 'approval.*'`),
    ).toEqual([]);

    // THE BOUND IS THE CONTEXT'S AND NOT THE TRANSPORT'S. The validator checks the
    // SHAPE — a non-empty string — and 201 characters is a well-formed string, so a
    // transport that also owned the length would be a second copy of a rule the
    // context states once.
    const tooLong = await call("PUT", POLICIES(ALPHA_ENVIRONMENT), {
      token: ALPHA_OWNER_TOKEN,
      body: { pattern: "x".repeat(201), state: "block" },
    });
    expect(tooLong.status).toBe(400);
    expect(errorCode(tooLong)).toBe("TOOLS_POLICY_PATTERN_INVALID");

    // AND THE TRANSPORT'S OWN REFUSAL IS A DIFFERENT CODE WITH `fields[]`, which is
    // what M0.4 §2 put `fields` in the envelope for.
    const malformed = await call("PUT", POLICIES(ALPHA_ENVIRONMENT), {
      token: ALPHA_OWNER_TOKEN,
      body: { pattern: "", state: "nonsense" },
    });
    expect(malformed.status).toBe(400);
    expect(errorCode(malformed)).toBe("TRANSPORT_REQUEST_INVALID");
    const fields = (errorOf(malformed)["fields"] ?? []) as readonly Record<string, unknown>[];
    expect(fields.map((field) => field["field"]).sort()).toEqual(["body.pattern", "body.state"]);
  });

  it("NO SESSION IS `UNAUTHENTICATED` on all three routes, and none of them reaches the terminal 404", async () => {
    for (const [method, path] of [
      ["GET", POLICIES(ALPHA_ENVIRONMENT)],
      ["PUT", POLICIES(ALPHA_ENVIRONMENT)],
      ["DELETE", `${POLICIES(ALPHA_ENVIRONMENT)}/${randomUUID()}`],
    ] as const) {
      const answer = await call(method, path, {
        ...(method === "PUT" ? { body: { pattern: "anon.*", state: "block" } } : {}),
      });
      // A ROUTE THAT WERE NOT MOUNTED WOULD ANSWER `TRANSPORT_ROUTE_NOT_FOUND` HERE
      // and every authorization case above would still pass, because a 404 is not a
      // 200 either. This is the case that says the surface exists.
      expect(errorCode(answer), `${method} ${path}`).toBe("UNAUTHENTICATED");
    }
  });
});

/**
 * A GENUINE authorization for alpha's environment, minted by tenancy.
 *
 * Through `authorizeEnvironmentOperator`, which is the only thing that can put an
 * object in the register. A fixture that built one by hand would be building
 * exactly the forged value the cases above prove is refused.
 */
async function mintAlphaAuthorization(): Promise<unknown> {
  const tenancy = running.app.contexts.tenancy;
  if (tenancy === undefined) throw new Error("tenancy must be composed");
  const authorized = await tenancy.authorizeEnvironmentOperator({
    environmentId: asIdentifier(ALPHA_ENVIRONMENT),
    operator: { actorUserId: asIdentifier(ALPHA_OWNER), effectiveUserId: asIdentifier(ALPHA_OWNER) },
    access: "secret:mutate",
  });
  if (!authorized.ok) throw new Error(`tenancy refused the fixture grant: ${JSON.stringify(authorized.error)}`);
  return authorized.value;
}
