// The real-PostgreSQL harness the two integration suites share.
//
// It starts a container, applies the repository's OWN migrations — not a
// hand-written DDL script, because a schema this suite maintained separately
// would drift from the one that ships — and seeds the rows this adapter is not
// the writer of from a SQL fixture. See fixtures/identity-access-rows.sql for
// why those rows are seeded as SQL rather than as code.
//
// It FAILS when Docker is absent rather than skipping. A skipped integration
// suite and a passing one look identical in a CI summary, and this is the whole
// evidence WIN-258's acceptance asks for.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import type { OrganizationId, ProjectId } from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier } from "@platos/context-tenancy/application/ports/index.js";

import type { PostgresTenancyAdapter } from "./adapter.js";
import { buildPostgresTenancyAdapter } from "./adapter.js";
import type { TenancyDatabaseClient } from "./client.js";

/** Rows the SQL fixture creates. Named here so a suite never spells a UUID twice. */
export const OWNER_USER = "11111111-1111-4111-8111-111111111111";
export const SECOND_OWNER_USER = "22222222-2222-4222-8222-222222222222";
export const MEMBER_USER = "33333333-3333-4333-8333-333333333333";
export const OPERATOR_SESSION = "44444444-4444-4444-8444-444444444444";

/** The one instant every fixture row is stamped with, so nothing is time-dependent. */
export const AT = new Date("2026-05-01T09:00:00.000Z");

export interface TenancyHarness {
  readonly client: TenancyDatabaseClient;
  readonly adapter: PostgresTenancyAdapter;
  /** Every statement the client has sent since `resetStatements`. */
  statements(): readonly string[];
  resetStatements(): void;
  /** A fresh UUID, so no two cases in a suite can collide on a key. */
  freshId(kind: string): string;
  seedOrganization(slug: string): Promise<OrganizationId>;
  seedProject(organizationId: OrganizationId, slug: string): Promise<ProjectId>;
  stop(): Promise<void>;
}

const packageRoot = process.cwd();
const databasePackage = resolve(packageRoot, "../../../internal-packages/tenancy-database");
const prismaBinary = resolve(packageRoot, "../../../node_modules/.bin/prisma");

export async function startTenancyHarness(): Promise<TenancyHarness> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "pgvector/pgvector:pg16",
  ).start();
  const databaseUrl = container.getConnectionUri();

  execFileSync(
    prismaBinary,
    ["migrate", "deploy", "--schema", resolve(databasePackage, "prisma/schema.prisma")],
    { cwd: databasePackage, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" },
  );
  execFileSync(
    prismaBinary,
    [
      "db",
      "execute",
      "--url",
      databaseUrl,
      "--file",
      resolve(packageRoot, "fixtures/identity-access-rows.sql"),
    ],
    { cwd: databasePackage, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" },
  );

  const { PrismaClient } = await import("@platos/tenancy-database");
  const client = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: [{ emit: "event", level: "query" }],
  }) as TenancyDatabaseClient;

  let statements: string[] = [];
  const listening = client as unknown as {
    $on(event: "query", listener: (event: { query: string }) => void): void;
  };
  listening.$on("query", (event) => {
    statements.push(event.query);
  });

  const adapter = buildPostgresTenancyAdapter(client);
  let sequence = 0;

  const harness: TenancyHarness = {
    client,
    adapter,
    statements: () => statements,
    resetStatements: () => {
      statements = [];
    },
    freshId(kind: string): string {
      sequence += 1;
      return `bbbbbbbb-${kind}-4000-8000-${String(sequence).padStart(12, "0")}`;
    },
    async seedOrganization(slug: string): Promise<OrganizationId> {
      const id = asIdentifier<OrganizationId>(harness.freshId("0001"));
      await adapter.unitOfWork.run((transaction) =>
        adapter.saveOrganization(
          {
            id,
            slug: asIdentifier(slug),
            name: slug,
            archivedAt: null,
            createdAt: AT,
            updatedAt: AT,
          },
          transaction,
        ),
      );
      return id;
    },
    async seedProject(organizationId: OrganizationId, slug: string): Promise<ProjectId> {
      const id = asIdentifier<ProjectId>(harness.freshId("0002"));
      await adapter.unitOfWork.run((transaction) =>
        adapter.saveProject(
          {
            id,
            organizationId,
            slug: asIdentifier(slug),
            name: slug,
            archivedAt: null,
            createdAt: AT,
            updatedAt: AT,
          },
          transaction,
        ),
      );
      return id;
    },
    async stop(): Promise<void> {
      await adapter.close();
      await container.stop();
    },
  };
  return harness;
}
