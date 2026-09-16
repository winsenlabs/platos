// A REAL PostgreSQL HOLDING THE ROWS A LEGACY INSTALLATION HOLDS, WITH THIS
// PROCESS SERVING OVER IT.
//
// WIN-269 (M4.3). The clause is "existing entities reconnect without
// reconfiguration", and it cannot be proved against a database this suite
// created: a fresh schema with rows a suite wrote is a database whose every
// column was chosen by the thing under test. The rows have to predate it.
//
// -----------------------------------------------------------------------------
// WHY THE FIXTURE ARRIVES THROUGH A PROCESS AND NOT AN IMPORT
//
// The rows come from `seedAsLegacyBinary` in `@platos/tenancy-database`, written
// through the rebuilt client of the release that provisioned the legacy database
// — so no row can name a column that release did not have. That module cannot be
// imported from here: `scripts/arch/boundary-rules.mjs`'s `tenancy-prisma-only`
// bans `@prisma/*`, `prisma` and `@platos/tenancy-database` outside the two homes
// entitled to hold a client, and its own comment names `apps/core-api` as inside
// that scan.
//
// So `internal-packages/tenancy-database/scripts/seed-legacy-installation.mjs` is
// spawned, exactly as the sibling suites in this directory already spawn
// `prisma migrate deploy`, and it prints the identifiers back as JSON. A copy of
// the fixture here would be a second fixture that agrees with the first until one
// of them is edited — and both rehearsal suites in the tree already share that
// one.
//
// -----------------------------------------------------------------------------
// WHAT THE SEED LEAVES BEHIND, AND WHAT THIS FILE ADDS
//
// The legacy binary wrote a `User`, an `Organization`, a `Project`, two
// `Environment`s, an `Entity`, a `Tool`, an `EnvironmentEntityTool` and a
// `ToolHealth` — the whole chain a reconnect touches. It did NOT write an
// `OrganizationMembership` or an `OperatorSession`, because those are how a HUMAN
// reaches this surface and the legacy tool-sync socket authenticates an entity
// secret instead.
//
// This file adds exactly those two, through the adapter's own ports, AFTER the
// migrations have run. They are the caller, not the fixture: the rows under test
// are the legacy ones, and a membership written here cannot make an entity's
// tools appear.
//
// IT FAILS WHEN DOCKER IS ABSENT rather than skipping, for the reason every
// harness in this tree gives: a skipped integration suite and a passing one look
// identical in a CI summary.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { asIdentifier } from "@platos/kernel";

import { loadPlatformConfiguration } from "../config/platform.js";
import { createProcessDefaults, startCoreApi, type RunningCoreApi } from "../runtime/lifecycle.js";
import { constructAdapters, type AdapterConstruction } from "./adapter-bindings.js";
import { assembleContextPorts } from "./context-ports.js";
import { psqlConnectionUrl } from "./integration-database.js";

/**
 * THE AMBIENT ENVIRONMENT, COPIED AND FROZEN ONCE, at module load. That is the
 * shape `scripts/arch/env-access.mjs` declares for a test-support file, and the
 * shape every sibling here already uses.
 */
const AMBIENT: Readonly<Record<string, string | undefined>> = Object.freeze({ ...process.env });

/** A Redis this process cannot reach. Nothing under test needs one. */
const REDIS_DEAD_URL = "redis://127.0.0.1:1/";

const AT = new Date("2026-05-01T09:00:00.000Z");

/** The operator rows this harness adds on top of the legacy fixture. */
export const OPERATOR = Object.freeze({
  userId: "ffffffff-0001-4000-8000-000000000001",
  membershipId: "ffffffff-0002-4000-8000-000000000002",
  sessionId: "ffffffff-0003-4000-8000-000000000003",
  token: "win269-tool-sync-operator-session-token",
  email: "win269-tool-sync@example.test",
});

/**
 * A SECOND operator who is a MEMBER and holds no project membership.
 *
 * Gate 3 refuses them outright, which is what makes an authorization case in the
 * suite about the GRANT rather than about the route: without a second principal
 * every refusal could be explained by "no session".
 */
export const OUTSIDER = Object.freeze({
  userId: "ffffffff-0004-4000-8000-000000000004",
  membershipId: "ffffffff-0005-4000-8000-000000000005",
  sessionId: "ffffffff-0006-4000-8000-000000000006",
  token: "win269-tool-sync-outsider-session-token",
  email: "win269-tool-sync-outsider@example.test",
});

export interface LegacyIdentifiers {
  readonly ids: Readonly<Record<string, string>>;
  readonly legacyRetryCount: number;
  readonly baselineSha256: string;
  readonly baselineBytes: number;
  readonly legacyRelease: string;
}

export interface LegacyInstallation {
  readonly legacy: LegacyIdentifiers;
  readonly running: RunningCoreApi;
  readonly base: string;
  readonly construction: AdapterConstruction;
  /** A `psql` PROCESS outside the adapter's pool. Durability is somebody else seeing it. */
  observe(sql: string): Promise<string[]>;
  stop(): Promise<void>;
}

function repositoryRelative(...parts: string[]): string {
  return resolve(process.cwd(), ...parts);
}

export async function startLegacyInstallation(): Promise<LegacyInstallation> {
  const postgres: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "pgvector/pgvector:pg16",
  ).start();
  const databaseUrl = postgres.getConnectionUri();

  const observe = async (sql: string): Promise<string[]> => {
    const result = await postgres.exec([
      "psql", "-U", postgres.getUsername(), "-d", postgres.getDatabase(),
      "-t", "-A", "-F", "|", "-c", sql,
    ]);
    if (result.exitCode !== 0) throw new Error(`psql refused: ${result.output}`);
    return result.output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  };

  // THE LEGACY BINARY'S OWN WRITE, IN ITS OWN PROCESS. `psqlConnectionUrl` is not
  // used here: the script hands the url to PRISMA, which is what produced it.
  const databasePackage = repositoryRelative("../../internal-packages/tenancy-database");
  const seeded = execFileSync(
    process.execPath,
    [resolve(databasePackage, "scripts/seed-legacy-installation.mjs"), databaseUrl],
    { cwd: databasePackage, env: { ...AMBIENT, DATABASE_URL: databaseUrl }, encoding: "utf8" },
  );
  const legacy = JSON.parse(seeded.trim().split("\n").at(-1) ?? "{}") as LegacyIdentifiers;
  if (typeof legacy.ids?.["entity"] !== "string") {
    throw new Error(`the legacy seed printed no identifiers: ${seeded}`);
  }

  const platform = loadPlatformConfiguration({
    PLATOS_ENVIRONMENT: "test",
    PLATOS_CORE_API_PORT: "0",
    PLATOS_STORE_POSTGRES_URL: databaseUrl,
    PLATOS_STORE_REDIS_URL: AMBIENT["PLATOS_REDIS_INTEGRATION_URL"] ?? REDIS_DEAD_URL,
    PLATOS_PROVIDERS_DEFAULT_MODEL: "anthropic:claude-haiku-4-5-20251001",
    PLATOS_SECURITY_ENCRYPTION_KEY: "f".repeat(64),
    PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "4",
  });
  if (!platform.ok) {
    throw new Error(`platform configuration refused: ${JSON.stringify(platform.diagnostics)}`);
  }
  const defaults = createProcessDefaults(platform.value.core);
  const construction = constructAdapters({
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

  const organizationId = legacy.ids["organization"] ?? "";
  await store.users.upsertByEmail(asIdentifier(OPERATOR.email), asIdentifier(OPERATOR.userId));
  await store.users.upsertByEmail(asIdentifier(OUTSIDER.email), asIdentifier(OUTSIDER.userId));
  await store.unitOfWork.run(async (transaction) => {
    // OWNER, because gate 4 narrows `secret:mutate` to an organization admin or a
    // project ADMIN, and `/tools/sync` asks at that level.
    await store.saveOrganizationMembership(
      { id: asIdentifier(OPERATOR.membershipId), organizationId: asIdentifier(organizationId), userId: asIdentifier(OPERATOR.userId), role: "OWNER", deactivatedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
    // MEMBER with no project membership: gates 1 and 2 pass, gate 3 refuses.
    await store.saveOrganizationMembership(
      { id: asIdentifier(OUTSIDER.membershipId), organizationId: asIdentifier(organizationId), userId: asIdentifier(OUTSIDER.userId), role: "MEMBER", deactivatedAt: null, createdAt: AT, updatedAt: AT } as never,
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
  await store.operatorSessions.save(session(OPERATOR.sessionId, OPERATOR.token, OPERATOR.userId));
  await store.operatorSessions.save(session(OUTSIDER.sessionId, OUTSIDER.token, OUTSIDER.userId));

  const running = await startCoreApi({
    configuration: platform.value.core,
    adapters: construction.adapters,
    ports: assembly.ports,
    unwired: construction.unwired,
    clock: defaults.clock,
    ids: defaults.ids,
    logger: defaults.logger,
  });

  return {
    legacy,
    running,
    construction,
    base: `http://${running.host}:${String(running.port)}`,
    observe,
    async stop(): Promise<void> {
      // The reason a stop is given a reason: `lifecycle.ts` logs it, and a
      // teardown that could not say why it was stopping is one an operator
      // reading the log cannot tell from a crash.
      await running.stop("tool-sync integration suite finished");
      await postgres.stop();
    },
  };
}

/** The `psql`-addressable form of a Prisma url. Re-exported so a suite names it once. */
export { psqlConnectionUrl };

export interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly text: string;
}

export async function post(
  base: string,
  path: string,
  options: { readonly token?: string; readonly key?: string; readonly body?: unknown } = {},
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
  return { status: response.status, body, text };
}
