// AN OPERATOR AUTHENTICATES THROUGH A COMPOSED `identity-access`, over a real
// PostgreSQL and a real Redis, and a rate-limit refusal lands a real row.
//
// ---------------------------------------------------------------------------
// WHY THIS SUITE EXISTS, AND WHY NOTHING SMALLER WOULD DO
//
// M4 has been unable to make one claim for four tranches: that `apps/core-api`
// can AUTHENTICATE AN OPERATOR through a context it composed. Every proof of
// that so far has been made against doubles, and the doubles cannot fail in the
// two ways that matter:
//
//   `InMemoryIdentityAccessRepository` hashes nothing and holds a map, so a
//   `SecretHasher` that returned a constant would pass every one of the
//   context's own cases. Here `hasher.hash` is `node-crypto-digest` and the
//   digest it produces is the value PostgreSQL's `OperatorSession_tokenHash_check`
//   accepts -- 64 lowercase hex characters -- or the seed itself is refused.
//
//   `RecordingSafetySink` in `identity-access/application/testing.ts` appends to
//   an array. It cannot tell you whether the kernel port this process actually
//   holds writes a `SafetyEvent` row, because it IS the port in those suites.
//   Here the sink is `governance`'s own `createGovernanceSafetyEventSink` over
//   `postgres-tenancy`'s `SafetyLedger`, and the row is counted on a SECOND
//   connection the adapter's pool never touched.
//
// THE COMPOSITION IS `main.ts`'s, NOT THIS FILE'S. `construct` ->
// `assembleContextPorts` -> `composeApplication` is copied from `main.ts` line
// for line, because a suite that wired its own bundle would be proving that a
// bundle this file assembled works, which is the assertion-against-itself this
// programme has already paid for.
//
// AND `governance` IS STILL NOT COMPOSED. `app.contexts.governance` is asserted
// UNDEFINED here on purpose: the sink is a kernel port built from three named
// slots, not a context, and a reader who took "the safety row was written" for
// "governance is composed" would be wrong. `installation.test.ts` carries the
// chain that stops it.
//
// IT FAILS WHEN DOCKER IS ABSENT RATHER THAN SKIPPING. A skipped integration
// suite and a passing one look identical in a CI summary.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asIdentifier } from "@platos/kernel";
import type { EnvironmentScope } from "@platos/kernel";

import { composeApplication, type AppModule } from "../app.module.js";
import { loadPlatformConfiguration } from "../config/platform.js";
import { createProcessDefaults } from "../runtime/lifecycle.js";
import { constructAdapters, type AdapterConstruction } from "./adapter-bindings.js";
import { assembleContextPorts, type ContextPortAssembly } from "./context-ports.js";

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
const ORGANIZATION = "aaaaaaaa-0001-4000-8000-000000000001";
const PROJECT = "aaaaaaaa-0002-4000-8000-000000000002";
const ENVIRONMENT = "aaaaaaaa-0003-4000-8000-000000000003";
const USER = "aaaaaaaa-0004-4000-8000-000000000004";
const SESSION = "aaaaaaaa-0005-4000-8000-000000000005";
const EXPIRED_SESSION = "aaaaaaaa-0006-4000-8000-000000000006";

/** The raw token an operator would present. Never stored; only its digest is. */
const TOKEN = "operator-session-token-win267";
const EXPIRED_TOKEN = "operator-session-token-win267-expired";

const SCOPE: EnvironmentScope = Object.freeze({
  level: "environment",
  organizationId: asIdentifier(ORGANIZATION),
  projectId: asIdentifier(PROJECT),
  environmentId: asIdentifier(ENVIRONMENT),
}) as EnvironmentScope;

let postgres: StartedPostgreSqlContainer;
let redis: StartedRedisContainer;
let construction: AdapterConstruction;
let assembly: ContextPortAssembly;
let app: AppModule;
function packageRootRelative(...parts: string[]): string {
  return resolve(process.cwd(), ...parts);
}

/**
 * Read a row back from SOMEBODY ELSE'S CONNECTION -- a `psql` process inside the
 * container, not this process's pool.
 *
 * WHY `psql` AND NOT A SECOND PRISMA CLIENT. `tenancy-prisma-only` in
 * `scripts/arch/boundary-rules.mjs` pins `@prisma/*` and
 * `@platos/tenancy-database` to `packages/adapters/postgres-tenancy` and to
 * nothing else, so a second client opened HERE would be a boundary violation --
 * the observer would have to break the rule the thing under test exists to keep.
 * A process inside the container is a stronger witness anyway: it shares no
 * pool, no driver and no transaction with the adapter, so "the row is there when
 * somebody else looks" is literal.
 */
async function observe(sql: string): Promise<string[]> {
  const result = await postgres.exec([
    "psql",
    "-U",
    postgres.getUsername(),
    "-d",
    postgres.getDatabase(),
    "-t",
    "-A",
    "-F",
    "|",
    "-c",
    sql,
  ]);
  if (result.exitCode !== 0) throw new Error(`psql refused: ${result.output}`);
  return result.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
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

  // EXACTLY WHAT `main.ts` DOES, in the same order and with the same calls.
  const environment = {
    PLATOS_ENVIRONMENT: "test",
    PLATOS_CORE_API_PORT: "0",
    PLATOS_STORE_POSTGRES_URL: databaseUrl,
    PLATOS_STORE_REDIS_URL: redis.getConnectionUrl(),
    PLATOS_PROVIDERS_DEFAULT_MODEL: "anthropic:claude-haiku-4-5-20251001",
    PLATOS_SECURITY_ENCRYPTION_KEY: "b".repeat(64),
    PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "3",
  };
  const platform = loadPlatformConfiguration(environment);
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
  assembly = assembleContextPorts(construction.adapters, defaults);
  app = composeApplication({
    configuration: platform.value.core,
    clock: defaults.clock,
    ids: defaults.ids,
    logger: defaults.logger,
    adapters: construction.adapters,
    ports: assembly.ports,
    unwired: construction.unwired,
  });

  // SEEDED THROUGH THE ADAPTER'S OWN PORTS, never through SQL. A fixture that
  // wrote these rows directly would be skipping the store under test -- the
  // reason `identity-harness.ts` stopped seeding `User` as SQL.
  const store = construction.adapters["postgres-tenancy"];
  if (store === undefined) throw new Error("postgres-tenancy must be constructed");
  await store.unitOfWork.run(async (transaction) => {
    await store.saveOrganization(
      {
        id: asIdentifier(ORGANIZATION),
        slug: asIdentifier("win267"),
        name: "WIN-267",
        archivedAt: null,
        createdAt: AT,
        updatedAt: AT,
      } as never,
      transaction,
    );
    await store.saveProject(
      {
        id: asIdentifier(PROJECT),
        organizationId: asIdentifier(ORGANIZATION),
        slug: asIdentifier("win267-project"),
        name: "WIN-267 project",
        archivedAt: null,
        createdAt: AT,
        updatedAt: AT,
      } as never,
      transaction,
    );
    await store.saveEnvironment(
      {
        id: asIdentifier(ENVIRONMENT),
        projectId: asIdentifier(PROJECT),
        slug: asIdentifier("prod"),
        name: "Production",
        archivedAt: null,
        accessKeyRevocationVersion: 0,
        memoryFeedbackBackfillCursor: null,
        memoryFeedbackBackfillCompletedAt: null,
        createdAt: AT,
        updatedAt: AT,
      } as never,
      transaction,
    );
  });
  await store.users.upsertByEmail(asIdentifier("operator@example.test"), asIdentifier(USER));

  // THE DIGEST COMES FROM THE ADAPTER THIS PROCESS COMPOSED, not from a literal
  // and not from `node:crypto` spelled again here. If `node-crypto-digest` ever
  // stopped producing what the column's CHECK constraint accepts, the seed
  // itself would fail and this suite would go red at setup rather than pass.
  const hasher = construction.adapters["node-crypto-digest"];
  if (hasher === undefined) throw new Error("node-crypto-digest must be constructed");
  await store.operatorSessions.save({
    sessionId: asIdentifier(SESSION),
    tokenHash: hasher.hash(TOKEN),
    tier: "OPERATOR",
    userId: asIdentifier(USER),
    impersonatedUserId: null,
    parentSessionId: null,
    mfaVerifiedAt: null,
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    revokedAt: null,
    lastSeenAt: null,
    createdAt: AT,
  } as never);
  await store.operatorSessions.save({
    sessionId: asIdentifier(EXPIRED_SESSION),
    tokenHash: hasher.hash(EXPIRED_TOKEN),
    tier: "OPERATOR",
    userId: asIdentifier(USER),
    impersonatedUserId: null,
    parentSessionId: null,
    mfaVerifiedAt: null,
    expiresAt: new Date("2026-05-02T00:00:00.000Z"),
    revokedAt: null,
    lastSeenAt: null,
    createdAt: AT,
  } as never);
}, 300_000);

afterAll(async () => {
  await construction?.release();
  await redis?.stop();
  await postgres?.stop();
});

describe("an operator authenticating through the composed identity-access", () => {
  it("is COMPOSED, and governance is not", () => {
    // THE PRECONDITION, ASSERTED RATHER THAN ASSUMED. Every case below would be
    // vacuous against an absent context -- `identityAccess?.authenticateOperator`
    // on undefined is a TypeError, not a failed assertion, and a suite that
    // optional-chained past it would report green having tested nothing.
    expect(app.contexts.identityAccess).toBeDefined();
    expect(app.contexts.identityAccess?.name).toBe("identity-access");
    expect(app.contexts.governance, "the sink is a port, not a composed context").toBeUndefined();
    expect(assembly.safetyEventSink).not.toBeNull();
    expect(assembly.ports.identityAccess?.safety).toBe(assembly.safetyEventSink);
  });

  it("AUTHENTICATES a live session token and answers the operator behind it", async () => {
    const identityAccess = app.contexts.identityAccess;
    if (identityAccess === undefined) throw new Error("identity-access must be composed");

    const authenticated = await identityAccess.authenticateOperator({ presentedToken: TOKEN });
    expect(authenticated.ok, JSON.stringify(authenticated)).toBe(true);
    if (!authenticated.ok) return;
    // THE VIEW NAMES THE SEEDED USER, which is what makes this an authentication
    // rather than a boolean. A store that answered the wrong session would
    // satisfy `ok` and fail here.
    expect(authenticated.value.actorUserId).toBe(USER);
    expect(authenticated.value.sessionId).toBe(SESSION);
  });

  it("STAMPS lastSeenAt, and a second connection sees it", async () => {
    const identityAccess = app.contexts.identityAccess;
    if (identityAccess === undefined) throw new Error("identity-access must be composed");
    await identityAccess.authenticateOperator({ presentedToken: TOKEN });

    // READ BY SOMEBODY ELSE. A writer can see its own uncommitted rows, so the
    // liveness stamp is checked on a client this adapter's pool never touched --
    // the same argument `harness.ts` makes for exposing `databaseUrl`.
    const rows = await observe(
      `SELECT COALESCE("lastSeenAt"::text, 'NULL') FROM "OperatorSession" WHERE "id" = '${SESSION}'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0], "a successful authentication stamps liveness").not.toBe("NULL");
  });

  it("REFUSES an unknown token, an expired session and no token at all", async () => {
    const identityAccess = app.contexts.identityAccess;
    if (identityAccess === undefined) throw new Error("identity-access must be composed");

    // THE THREE REFUSALS ARE SEPARATE CASES BECAUSE THEY TAKE SEPARATE PATHS,
    // and a suite that only tried a wrong token would pass against a store that
    // never checked expiry at all.
    const unknown = await identityAccess.authenticateOperator({ presentedToken: "not-a-token" });
    expect(unknown.ok).toBe(false);
    const expired = await identityAccess.authenticateOperator({ presentedToken: EXPIRED_TOKEN });
    expect(expired.ok).toBe(false);
    const absent = await identityAccess.authenticateOperator({ presentedToken: null });
    expect(absent.ok).toBe(false);

    // AND THE EXPIRED SESSION IS A REAL ROW, so the refusal above is expiry and
    // not a lookup miss. Without this the case would pass against a store that
    // had simply failed to save the second seed.
    expect(
      await observe(`SELECT "id" FROM "OperatorSession" WHERE "id" = '${EXPIRED_SESSION}'`),
    ).toEqual([EXPIRED_SESSION]);

    // A FAILED AUTHENTICATION LEAVES NO TRACE. `authenticate-operator.ts` stamps
    // liveness AFTER the decision precisely so a token can not be confirmed to
    // exist by watching a timestamp move; the expired session must therefore
    // still carry a null stamp.
    const untouched = await observe(
      `SELECT COALESCE("lastSeenAt"::text, 'NULL') FROM "OperatorSession" WHERE "id" = '${EXPIRED_SESSION}'`,
    );
    expect(untouched).toEqual(["NULL"]);
  });

  it("WRITES A REAL SafetyEvent when the rate limiter refuses, through governance's sink", async () => {
    const identityAccess = app.contexts.identityAccess;
    if (identityAccess === undefined) throw new Error("identity-access must be composed");

    const before = await countSafetyEvents();

    // THE POLICY IS THE CONTEXT'S OWN AND THIS FILE CANNOT SET IT.
    // `RateLimitRequest` carries no `policy` field -- the CONTRACT deliberately
    // exposes action, identifier, scope and principal and nothing else -- so the
    // limit that applies is `DEFAULT_POLICIES.MFA_VERIFY`, decided in
    // `identity-access/domain/rate-limit.ts` and enforced by a Lua script in
    // real Redis. That is the point: the refusal below is the DOMAIN's number
    // and the STORE's counter, neither of which this suite controls.
    //
    // THE FIRST DRAFT OF THIS CASE PASSED A `policy` AND ASSERTED `ok` WITH A
    // "limited" OUTCOME. Both halves were wrong and the container said so: the
    // field is not on the request type, so the default applied; and
    // `asResult` turns a limited decision into an `err`, so `ok` is FALSE when
    // the limiter refuses. Recorded rather than quietly fixed -- it is the
    // difference between reading the contract and assuming it.
    const request = {
      action: "MFA_VERIFY" as const,
      identifier: "operator@example.test",
      scope: SCOPE,
      principalId: null,
    };

    let allowed = 0;
    let refusal: { readonly code: string } | null = null;
    for (let call = 0; call < 20 && refusal === null; call += 1) {
      const decision = await identityAccess.consumeRateLimit(request);
      if (decision.ok) {
        // `degraded` would mean the limiter was UNREACHABLE and the fail-open
        // policy applied. That is a different path with a different rule
        // (`identity.rate_limit.degraded`), and a case that accepted it would be
        // asserting the sink works when Redis is DOWN -- the opposite of this.
        expect(decision.value.outcome, "the limiter must be reachable").toBe("allowed");
        allowed += 1;
        continue;
      }
      refusal = decision.error;
    }

    expect(refusal, "the limiter must refuse within twenty calls").not.toBeNull();
    expect(refusal?.code).toBe("RATE_LIMITED");
    // JOINED TO THE COMMITTED TAXONOMY, not to a literal here: the status a
    // transport will map this to is a fact the repository ships.
    expect(committedStatus("RATE_LIMITED")).toBe(429);
    // AND THE COUNT IS THE DOMAIN'S. `DEFAULT_MFA_VERIFY_POLICY` is five
    // requests and `decide` refuses when the bucket EXCEEDS it, so five pass and
    // the sixth is refused. A Lua script that reset the window, or an adapter
    // that counted per call rather than per bucket, changes this number.
    expect(allowed).toBe(5);

    // THE ROW, COUNTED FROM A PROCESS INSIDE THE CONTAINER. This is the whole
    // claim of the suite's second half: the kernel `SafetyEventSink` this
    // process holds is governance's real implementation over the canonical
    // store, not a recorder that appends to an array.
    expect(await countSafetyEvents(), "the refusal must have appended exactly one row").toBe(
      before + 1,
    );

    const rows = await observe(
      `SELECT "detector", "action", "severity", "environmentId"
         FROM "SafetyEvent" ORDER BY "createdAt" DESC LIMIT 1`,
    );
    const columns = (rows[0] ?? "").split("|");
    // EVERY COLUMN IS A DECISION GOVERNANCE'S DOMAIN MADE, not a value this file
    // passed in. `identity.rate_limit.exceeded` is split by
    // `domain/safety-observation.ts` into the `rate_limit` detector;
    // `OUTCOME_ACTIONS.blocked` is `block` and `OUTCOME_SEVERITIES.blocked` is
    // `high`. A sink that wrote the observation through unmapped would fail here.
    expect(columns).toEqual(["rate_limit", "block", "high", ENVIRONMENT]);
  });

  it("DROPS an observation it cannot scope, rather than inventing an environment", async () => {
    // THE SINK'S OWN CONTRACT, AND THE HALF A RECORDING DOUBLE CANNOT SHOW.
    // `SafetyEvent` hangs off `Environment`; an observation addressed at an
    // organization has no row to be. `safety-event-sink.ts` drops and logs it
    // rather than filing it against an arbitrary environment -- so the row count
    // must NOT move, and the call must not throw, because the kernel port
    // forbids failing its caller.
    const sink = assembly.safetyEventSink;
    if (sink === null) throw new Error("the sink must have been minted");

    const before = await countSafetyEvents();
    await expect(
      sink.record({
        rule: "identity.rate_limit.exceeded",
        outcome: "blocked",
        scope: { level: "organization", organizationId: asIdentifier(ORGANIZATION) } as never,
        principalId: null,
        observedAt: AT,
        details: {},
      }),
    ).resolves.toBeUndefined();
    expect(await countSafetyEvents(), "an unscoped observation must write nothing").toBe(before);

    // AND AN UNKNOWN DETECTOR IS DROPPED THE SAME WAY, which is the other half
    // of `admitSafetyEvent`'s vocabulary rule: an unregistered bucket corrupts
    // every rollup taken afterwards and no retry fixes it.
    await expect(
      sink.record({
        rule: "identity.not_a_detector.exceeded",
        outcome: "blocked",
        scope: SCOPE,
        principalId: null,
        observedAt: AT,
        details: {},
      }),
    ).resolves.toBeUndefined();
    expect(await countSafetyEvents(), "an unknown detector must write nothing").toBe(before);
  });
});

async function countSafetyEvents(): Promise<number> {
  const rows = await observe(`SELECT COUNT(*) FROM "SafetyEvent"`);
  return Number.parseInt(rows[0] ?? "0", 10);
}
