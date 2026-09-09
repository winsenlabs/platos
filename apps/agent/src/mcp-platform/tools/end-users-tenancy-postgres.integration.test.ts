/**
 * WIN-268 P3 — `end_users.*` tenancy, proved against a real PostgreSQL with two
 * tenants and a FORGED scope triple.
 *
 * WHY THE EXISTING SUITE IS NOT THIS. `end-users.test.ts` drives the four tools
 * with `vi.fn()` in place of the client and asserts the `where` clause that was
 * passed. That proves the module builds the query it was written to build; it
 * cannot prove the query EXCLUDES anything, because a double has no rows, no
 * foreign keys and no triggers. Every refusal below is decided by PostgreSQL.
 *
 * WHY A FOREIGN TRIPLE IS NOT ENOUGH. A caller presenting all three ids of
 * another tenant is COHERENT — it just points somewhere else, and a query with
 * no tenancy at all would still answer "not found" for a row it does not have.
 * The separating case is the FORGED triple: three ids that individually exist,
 * do NOT form one ancestry, and are accepted as a scope because
 * `apps/agent/src/auth/scope.guard.ts` reads them from three independent headers
 * and never checks that the environment lives under the organization.
 *
 * WHAT THIS SUITE ESTABLISHES:
 *   1. the coherent triple answers (without it, every refusal is a broken query);
 *   2. `scope.projectId` is NEVER read — a forged project answers identically,
 *      and that is pinned so a conversion to a scoped contract call is visible;
 *   3. neither forged (organization, environment) pairing reaches the other
 *      tenant, on reads OR writes, and the writes are checked at the STORE and
 *      not by the return value;
 *   4. the row that would break the conjunction cannot be created — the
 *      database refuses it with the ancestry trigger, by SQLSTATE and message.
 *
 * (4) is where the safety actually lives. `scripts/arch/end-user-presence-ancestry.mjs`
 * holds the static half: every relation the presence clause names resolves to a
 * model carrying that trigger.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@platos/tenancy-database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildEndUserToolHandlers } from "./end-users";
import type { RequestScope } from "../../auth/scope.guard";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const baseDatabaseUrl =
  process.env.END_USER_TENANCY_TEST_DATABASE_URL ??
  process.env.PLATOS_POSTGRES_INTEGRATION_DATABASE_URL ??
  process.env.DATABASE_URL;

// A SKIP HAS TO BE VISIBLE. A suite that quietly reports green with no database
// is exactly how a tranche reported 218/218 and merged two regressions, so a
// runner that MEANT to prove tenancy sets this and gets a failure instead of a
// silent pass.
if (process.env.END_USER_TENANCY_REQUIRED === "1" && !baseDatabaseUrl) {
  throw new Error(
    "END_USER_TENANCY_REQUIRED=1 but no database URL is set; " +
      "export END_USER_TENANCY_TEST_DATABASE_URL (or DATABASE_URL) to run this suite",
  );
}

const describeWithDatabase = baseDatabaseUrl ? describe : describe.skip;
const { Client } = require("pg") as { Client: new (options: unknown) => any };

interface Tenant {
  organizationId: string;
  projectId: string;
  environmentId: string;
  agentId: string;
  endUserId: string;
  operatorUserId: string;
}

function scopeOf(
  parts: { organizationId: string; projectId: string; environmentId: string },
  userId: string,
): RequestScope {
  return {
    organizationId: parts.organizationId,
    projectId: parts.projectId,
    environmentId: parts.environmentId,
    userId,
    principal: "operator",
  } as RequestScope;
}

describeWithDatabase("end_users.* tenancy against real PostgreSQL", () => {
  let admin: any;
  let adminConnected = false;
  let prisma: PrismaClient;
  let schemaName: string;
  let alpha: Tenant;
  let beta: Tenant;
  let handlers: ReturnType<typeof buildEndUserToolHandlers>;

  const tool = (name: string) => {
    const handler = handlers.find((candidate) => candidate.name === name);
    if (!handler) throw new Error(`no handler named ${name}`);
    return handler;
  };

  async function seedTenant(label: string): Promise<Tenant> {
    const operator = await prisma.user.create({
      data: { email: `${schemaName}-${label}@test.invalid`, displayName: `${label} operator` },
    });
    const organization = await prisma.organization.create({
      data: { slug: `${schemaName}-${label}`, name: `${label} org` },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: organization.id, userId: operator.id, role: "OWNER" },
    });
    const project = await prisma.project.create({
      data: { organizationId: organization.id, slug: `${schemaName}-${label}`, name: `${label} project` },
    });
    const environment = await prisma.environment.create({
      data: { projectId: project.id, slug: "development", name: "Development" },
    });
    const agent = await prisma.agent.create({
      data: { projectId: project.id, slug: `${schemaName}-${label}`, name: `${label} agent` },
    });
    const agentVersion = await prisma.agentVersion.create({
      data: { agentId: agent.id, versionNumber: 1, model: "fixture:model", createdBy: operator.id },
    });
    await prisma.agentBinding.create({
      data: { environmentId: environment.id, agentId: agent.id, activeAgentVersionId: agentVersion.id },
    });
    const endUser = await prisma.endUser.create({
      data: { organizationId: organization.id, displayName: `${label} customer` },
    });
    await prisma.endUserIdentity.create({
      data: {
        endUserId: endUser.id,
        organizationId: organization.id,
        issuer: "platos:mcp-manual",
        channel: "email",
        subject: `${label}@customer.invalid`,
      },
    });
    // The presence row. Without it the end user is invisible to every tool here,
    // which is the environment-authority rule the module is built on.
    await prisma.thread.create({
      data: { environmentId: environment.id, agentId: agent.id, endUserId: endUser.id },
    });
    return {
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      agentId: agent.id,
      endUserId: endUser.id,
      operatorUserId: operator.id,
    };
  }

  beforeAll(async () => {
    schemaName = `endusers_${process.pid}_${Date.now()}`;
    admin = new Client({ connectionString: baseDatabaseUrl });
    await admin.connect();
    adminConnected = true;

    // EVERY migration, in order — not just the initial one. `Thread_ancestry` is
    // dropped and recreated against a different function by
    // `20260824233000_m4_forward_upgrade_contract`, and a fixture built from the
    // initial migration alone would be proving a trigger production no longer runs.
    const migrationsRoot = resolve(
      process.cwd(),
      "../../internal-packages/tenancy-database/prisma/migrations",
    );
    const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(migrations.length).toBeGreaterThan(1);
    for (const migration of migrations) {
      const sql = readFileSync(resolve(migrationsRoot, migration, "migration.sql"), "utf8")
        .replaceAll('"public"', `"${schemaName}"`);
      await admin.query(sql);
    }

    const url = new URL(baseDatabaseUrl!);
    url.searchParams.set("schema", schemaName);
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });

    alpha = await seedTenant("alpha");
    beta = await seedTenant("beta");

    handlers = buildEndUserToolHandlers({
      prisma,
      toolAudit: { record: vi.fn().mockResolvedValue(undefined) } as any,
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (adminConnected) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.end();
    }
  });

  it("the coherent triple reaches its own end user", async () => {
    const result: any = await tool("end_users.get").execute(
      { platosEndUserId: alpha.endUserId },
      scopeOf(alpha, alpha.operatorUserId),
      {} as any,
    );
    expect(result.error).toBeUndefined();
    expect(result.id).toBe(alpha.endUserId);
    expect(result.threadCount).toBe(1);
  });

  it("a wholly FOREIGN triple cannot reach another tenant's end user", async () => {
    // The weak case, kept as the floor: a coherent scope pointing elsewhere.
    // A query with no tenancy at all would also pass this, which is why the
    // forged cases below exist.
    const result: any = await tool("end_users.get").execute(
      { platosEndUserId: alpha.endUserId },
      scopeOf(beta, beta.operatorUserId),
      {} as any,
    );
    expect(result).toEqual({ error: "not_found", platosEndUserId: alpha.endUserId });
  });

  it("FORGED: scope.projectId is never read, so a foreign project answers identically", async () => {
    // A FINDING, pinned rather than corrected. The module authorises on
    // (organizationId, environmentId) only; the third component of the triple
    // reaches no query. The day this call is routed to a contract that takes a
    // whole TenantScope, that changes — and this expectation is what makes the
    // change visible instead of silent.
    const forged = scopeOf(
      {
        organizationId: alpha.organizationId,
        projectId: beta.projectId,
        environmentId: alpha.environmentId,
      },
      alpha.operatorUserId,
    );
    const result: any = await tool("end_users.get").execute(
      { platosEndUserId: alpha.endUserId },
      forged,
      {} as any,
    );
    expect(result.id).toBe(alpha.endUserId);
  });

  it("FORGED: the victim's organization with the caller's environment reaches nothing", async () => {
    const forged = scopeOf(
      {
        organizationId: beta.organizationId,
        projectId: alpha.projectId,
        environmentId: alpha.environmentId,
      },
      alpha.operatorUserId,
    );
    const result: any = await tool("end_users.get").execute(
      { platosEndUserId: beta.endUserId },
      forged,
      {} as any,
    );
    expect(result).toEqual({ error: "not_found", platosEndUserId: beta.endUserId });
  });

  it("FORGED: the caller's organization with the victim's environment reaches nothing", async () => {
    const forged = scopeOf(
      {
        organizationId: alpha.organizationId,
        projectId: alpha.projectId,
        environmentId: beta.environmentId,
      },
      alpha.operatorUserId,
    );
    const result: any = await tool("end_users.get").execute(
      { platosEndUserId: alpha.endUserId },
      forged,
      {} as any,
    );
    expect(result).toEqual({ error: "not_found", platosEndUserId: alpha.endUserId });
  });

  it("the database refuses the presence row that would break the conjunction", async () => {
    // THE LOAD-BEARING CASE. `end_users.*` is safe under a forged
    // (organization, environment) pair only because no row can join one
    // tenant's end user to the other tenant's environment. That is a PostgreSQL
    // trigger, not a line of TypeScript, so it is asserted by SQLSTATE and by
    // the message the migration raises.
    let raised: any = null;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${schemaName}"."Thread" ("id", "environmentId", "agentId", "endUserId")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid)`,
        alpha.environmentId,
        alpha.agentId,
        beta.endUserId,
      );
    } catch (error) {
      raised = error;
    }
    expect(raised, "PostgreSQL accepted a cross-tenant Thread — end_users.* now leaks").not.toBeNull();
    const text = String(raised?.message ?? raised);
    expect(text).toContain("Thread crosses its canonical owner ancestry");

    // And the leak the row would have caused does not happen.
    const forged = scopeOf(
      {
        organizationId: beta.organizationId,
        projectId: beta.projectId,
        environmentId: alpha.environmentId,
      },
      alpha.operatorUserId,
    );
    const result: any = await tool("end_users.get").execute(
      { platosEndUserId: beta.endUserId },
      forged,
      {} as any,
    );
    expect(result).toEqual({ error: "not_found", platosEndUserId: beta.endUserId });
  });

  it("the composite foreign key refuses an identity pointed across organizations", async () => {
    // EndUserIdentity carries NO ancestry trigger; its cross-tenant guard is the
    // composite [endUserId, organizationId] -> [id, organizationId] foreign key.
    // If that ever became a plain single-column key, a manual link could attach
    // one tenant's identity row to another tenant's person.
    await expect(
      prisma.endUserIdentity.create({
        data: {
          endUserId: beta.endUserId,
          organizationId: alpha.organizationId,
          issuer: "platos:mcp-manual",
          channel: "email",
          subject: "smuggled@customer.invalid",
        },
      }),
    ).rejects.toThrow();
  });

  it("FORGED: link_identity writes nothing, checked at the store", async () => {
    const before = await prisma.endUserIdentity.count({ where: { endUserId: beta.endUserId } });
    const forged = scopeOf(
      {
        organizationId: beta.organizationId,
        projectId: alpha.projectId,
        environmentId: alpha.environmentId,
      },
      alpha.operatorUserId,
    );
    const result: any = await tool("end_users.link_identity").execute(
      { platosEndUserId: beta.endUserId, channel: "email", handle: "attacker@evil.invalid" },
      forged,
      {} as any,
    );
    expect(result).toEqual({ error: "not_found", platosEndUserId: beta.endUserId });
    // The return value is not the evidence. The row count is.
    expect(await prisma.endUserIdentity.count({ where: { endUserId: beta.endUserId } })).toBe(before);
    expect(
      await prisma.endUserIdentity.count({ where: { subject: "attacker@evil.invalid" } }),
    ).toBe(0);
  });

  it("FORGED: unlink_identity leaves the victim's identity in place", async () => {
    const subject = "beta@customer.invalid";
    expect(await prisma.endUserIdentity.count({ where: { subject } })).toBe(1);
    const forged = scopeOf(
      {
        organizationId: beta.organizationId,
        projectId: alpha.projectId,
        environmentId: alpha.environmentId,
      },
      alpha.operatorUserId,
    );
    const result: any = await tool("end_users.unlink_identity").execute(
      { channel: "email", handle: subject },
      forged,
      {} as any,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_found");
    expect(await prisma.endUserIdentity.count({ where: { subject } })).toBe(1);
  });

  it("the coherent owner CAN unlink its own identity — the refusals above are not blanket", async () => {
    // Without this, every refusal in this file would also pass against a tool
    // that refuses everything.
    const subject = "alpha@customer.invalid";
    const result: any = await tool("end_users.unlink_identity").execute(
      { channel: "email", handle: subject },
      scopeOf(alpha, alpha.operatorUserId),
      {} as any,
    );
    expect(result.ok).toBe(true);
    expect(await prisma.endUserIdentity.count({ where: { subject } })).toBe(0);
  });
});
