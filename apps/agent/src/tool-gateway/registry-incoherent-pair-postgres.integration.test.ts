/**
 * WIN-269 (M4.3) — THE (entity, environment) PAIR, PROVED AGAINST A REAL
 * PostgreSQL, AND A HYPOTHESIS THE DATABASE REFUTED.
 *
 * AN ENTITY BELONGS TO A PROJECT. AN EXPOSURE BELONGS TO AN ENVIRONMENT. Those
 * are two different places in the tenant tree, and `EnvironmentEntityTool` is
 * the row that joins them. Read from `schema.prisma` alone the pair looks
 * unconstrained: an independent foreign key to each side,
 * `@@unique([environmentId, entityId, toolId])`, and nothing relating the two
 * projects. On that reading — which is the reading this suite was written to
 * confirm — the incoherent row is representable, and the only thing standing
 * between it and a served tool is one line in `ToolRegistryService.rebuildIndex`:
 *
 *     if (entity.projectId !== environment.projectId) continue;
 *
 * THE DATABASE SAYS OTHERWISE, AND THE DATABASE IS RIGHT. The insert is refused
 * with SQLSTATE 23514 and the message `EnvironmentEntityTool crosses its
 * canonical owner ancestry`, by the `EnvironmentEntityTool_ancestry` trigger
 * that `00000000000000_initial/migration.sql` installs over
 * `enforce_domain_ancestry()` and that
 * `20260824233000_m4_forward_upgrade_contract` redefines. None of that is in the
 * Prisma schema, which is exactly why the hypothesis survived reading it. The
 * finding is therefore recorded the way it came out rather than the way it was
 * expected:
 *
 *   THE PRIMARY GUARD IS THE DATABASE. The incoherent pair cannot exist.
 *   THE REGISTRY'S `continue` IS DEFENCE IN DEPTH over a rule that already
 *   holds — worth having, and worth saying, because it was ASSERTED BY NOTHING
 *   before this suite and a reader of the application code alone cannot tell a
 *   redundant guard from the only one.
 *
 * WHY IT MATTERS WHERE THE PRIMARY GUARD IS. Every scope key the registry mints
 * is built from BOTH sides of the pair —
 *
 *     organizationId  from the ENTITY's project
 *     projectId       from the ENTITY
 *     environmentId   from the MAPPING
 *
 * — so an incoherent row would not merely leak a tool: it would mint a scope
 * triple belonging to NO tenant, organization and project from one tree and
 * environment from another. That is precisely the forged triple
 * `apps/agent/src/auth/scope.guard.ts` accepts, because it reads its three ids
 * from three independent headers and never checks that the environment lives
 * under the organization. And `setToolEnabled`'s write carries no tenancy join
 * of its own — `environmentEntityTool.update({ where: {
 * environmentId_entityId_toolId: { environmentId: scope.environmentId, entityId:
 * entry.entityPk, toolId } } })`, with the cache hit as the whole
 * authorization. What makes that survivable is the trigger, and what makes it
 * worth writing down is that nothing in `apps/agent` says so.
 *
 * WHY A DOUBLE COULD NOT ESTABLISH ANY OF THIS. Every refusal below is decided
 * by PostgreSQL. A `vi.fn()` client has no triggers, so it would have ACCEPTED
 * the incoherent row and CONFIRMED THE WRONG HYPOTHESIS — which is what a
 * fixture-shaped version of this suite would have done, and is the reason it was
 * written against a real database instead.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@platos/tenancy-database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ToolRegistryService } from "./tool-registry.service";
import type { ScopeTuple } from "../providers/scoped-env.service";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

// NO `DATABASE_URL` FALLBACK, DELIBERATELY — the same decision, for the same
// reason, as `end-users-tenancy-postgres.integration.test.ts`:
// `apps/agent/test/setup.ts` stamps a fake URL into every worker so unit tests
// can read `env.*`, and a suite that fell back to it would find a truthy URL,
// decide it had a database, and fail `beforeAll` with `role "test" does not
// exist` on every machine without PostgreSQL — turning a SKIP into a RED.
const baseDatabaseUrl =
  process.env.TOOL_REGISTRY_TENANCY_TEST_DATABASE_URL ??
  process.env.PLATOS_POSTGRES_INTEGRATION_DATABASE_URL;

// A SKIP HAS TO BE VISIBLE, and this repository has the scar: a tranche reported
// 218/218 with the suites that mattered silently skipped and merged two
// regressions. A runner that MEANT to prove the pair sets this and gets a
// failure instead of a green.
if (process.env.TOOL_REGISTRY_TENANCY_REQUIRED === "1" && !baseDatabaseUrl) {
  throw new Error(
    "TOOL_REGISTRY_TENANCY_REQUIRED=1 but no database URL is set; " +
      "export TOOL_REGISTRY_TENANCY_TEST_DATABASE_URL or PLATOS_POSTGRES_INTEGRATION_DATABASE_URL",
  );
}

const describeWithDatabase = baseDatabaseUrl ? describe : describe.skip;

/** The named database objects that actually enforce the pair. */
const ANCESTRY_TRIGGER = "EnvironmentEntityTool_ancestry";
const ANCESTRY_SQLSTATE = "23514";
const ANCESTRY_MESSAGE = "EnvironmentEntityTool crosses its canonical owner ancestry";

interface Tenant {
  organizationId: string;
  projectId: string;
  environmentId: string;
  entityId: string;
  externalId: string;
  operatorUserId: string;
}

describeWithDatabase("the (entity, environment) pair against real PostgreSQL", () => {
  let admin: any;
  let adminConnected = false;
  let prisma: PrismaClient;
  let schemaName: string;
  let alpha: Tenant;
  let beta: Tenant;
  let toolId: string;

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
      data: {
        organizationId: organization.id,
        slug: `${schemaName}-${label}`,
        name: `${label} project`,
      },
    });
    const environment = await prisma.environment.create({
      data: { projectId: project.id, slug: "development", name: "Development" },
    });
    const entity = await prisma.entity.create({
      data: {
        projectId: project.id,
        externalId: `${label}-backend`,
        displayName: `${label} backend`,
        connectionKind: "wire",
        connectionStatus: "connected",
      },
    });
    return {
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      entityId: entity.id,
      externalId: entity.externalId,
      operatorUserId: operator.id,
    };
  }

  beforeAll(async () => {
    schemaName = `toolpair_${process.pid}_${Date.now()}`;
    const { Client } = require("pg") as { Client: new (options: unknown) => any };
    admin = new Client({ connectionString: baseDatabaseUrl });
    await admin.connect();
    adminConnected = true;

    // EVERY migration, in order. `enforce_domain_ancestry` is redefined by
    // `20260824233000_m4_forward_upgrade_contract`, and a fixture built from the
    // initial migration alone would be proving enforcement production no longer
    // runs.
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

    const tool = await prisma.tool.create({
      data: {
        name: "alpha.create_issue",
        description: "Create an issue",
        kind: "ENTITY",
        paramSchema: { type: "object" },
        schemaHash: `${schemaName}-hash`,
      },
    });
    toolId = tool.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect().catch(() => undefined);
    if (adminConnected) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });

  it("the ancestry rule is a NAMED, ENABLED trigger on the table, not a belief about the schema", async () => {
    // THE ANCHOR FOR EVERY REFUSAL BELOW. `schema.prisma` shows two independent
    // foreign keys and no relation between them; the rule lives in raw SQL that
    // Prisma does not model, which is exactly how this suite's original
    // hypothesis survived reading the schema. Joining to `pg_trigger` means that
    // the day the trigger is dropped these cases fail HERE, naming the missing
    // object, rather than passing because nothing refuses any more.
    const { rows } = await admin.query(
      `SELECT t.tgname, t.tgenabled
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'EnvironmentEntityTool' AND NOT t.tgisinternal`,
      [schemaName],
    );
    expect(rows.map((row: any) => row.tgname)).toContain(ANCESTRY_TRIGGER);
    // ...and it is ENABLED. A disabled trigger is present in the catalogue and
    // enforces nothing, which would make every refusal below a false positive.
    expect(rows.find((row: any) => row.tgname === ANCESTRY_TRIGGER).tgenabled).toBe("O");
  });

  it("PostgreSQL REFUSES an exposure whose entity and environment are in different projects", async () => {
    // THE HYPOTHESIS, REFUTED. This suite was written expecting the insert to
    // succeed and the application layer to be the only guard. It does not
    // succeed — and the refusal is checked by SQLSTATE AND message rather than
    // by "it threw", because a foreign-key violation, a unique violation and an
    // ancestry violation are all exceptions and only one of them is this
    // property.
    let raised: unknown = null;
    try {
      await prisma.environmentEntityTool.create({
        data: {
          environmentId: beta.environmentId, // beta's tree
          entityId: alpha.entityId, // alpha's tree
          toolId,
          enabled: true,
          callbackUrl: "https://alpha.example/tools",
        },
      });
    } catch (error) {
      raised = error;
    }
    expect(raised).not.toBeNull();
    expect(String(raised)).toContain(ANCESTRY_SQLSTATE);
    expect(String(raised)).toContain(ANCESTRY_MESSAGE);

    // And nothing landed — a refusal that left the row is not a refusal.
    expect(
      await prisma.environmentEntityTool.findFirst({
        where: { environmentId: beta.environmentId, entityId: alpha.entityId },
      }),
    ).toBeNull();
  });

  it("the COHERENT pair is accepted — without this the refusal above proves nothing", async () => {
    // THE NON-VACUITY CONTROL. A trigger that rejected every insert would pass
    // the case above and destroy the product; this is the same statement with
    // the pair repaired, and it must land.
    const mapping = await prisma.environmentEntityTool.create({
      data: {
        environmentId: alpha.environmentId,
        entityId: alpha.entityId,
        toolId,
        enabled: true,
        callbackUrl: "https://alpha.example/tools",
      },
    });
    expect(mapping.id).toBeTruthy();

    const readBack = await prisma.environmentEntityTool.findUniqueOrThrow({
      where: { id: mapping.id },
      include: {
        entity: { select: { projectId: true } },
        environment: { select: { projectId: true } },
      },
    });
    expect(readBack.entity.projectId).toBe(readBack.environment.projectId);
  });

  it("a coherent exposure cannot be MOVED into a foreign environment either", async () => {
    // THE UPDATE HALF, and it is the half that matters to this tranche.
    // `setToolEnabled` writes through the composite unique key with
    // `scope.environmentId` taken verbatim from the caller and no organization
    // or project join. What stops a retarget is this trigger firing `BEFORE
    // INSERT OR UPDATE`; an INSERT-only rule would leave the write path open
    // while the insert case above stayed green.
    const mapping = await prisma.environmentEntityTool.findFirstOrThrow({
      where: { environmentId: alpha.environmentId, entityId: alpha.entityId, toolId },
    });
    let raised: unknown = null;
    try {
      await prisma.environmentEntityTool.update({
        where: { id: mapping.id },
        data: { environmentId: beta.environmentId },
      });
    } catch (error) {
      raised = error;
    }
    expect(raised).not.toBeNull();
    expect(String(raised)).toContain(ANCESTRY_SQLSTATE);

    expect(
      (await prisma.environmentEntityTool.findUniqueOrThrow({ where: { id: mapping.id } }))
        .environmentId,
    ).toBe(alpha.environmentId);
  });

  it("the registry serves the coherent pair and answers NOTHING for either forged triple", async () => {
    const registry = new ToolRegistryService(prisma as any, undefined as any);
    await registry.rebuildIndex();

    const served = registry.getScopedTools(
      {
        organizationId: alpha.organizationId,
        projectId: alpha.projectId,
        environmentId: alpha.environmentId,
      } as any,
      { enabledOnly: false },
    );
    expect(served.map((entry) => entry.toolName)).toEqual(["alpha.create_issue"]);
    expect(served[0]!.entityPk).toBe(alpha.entityId);

    // The forged triple: organization and project from alpha (where the ENTITY
    // lives) and environment from beta. Every id exists and `scope.guard.ts`
    // reads all three from independent headers, so a caller can present it.
    expect(
      registry.getScopedTools(
        {
          organizationId: alpha.organizationId,
          projectId: alpha.projectId,
          environmentId: beta.environmentId,
        } as any,
        { enabledOnly: false },
      ),
    ).toEqual([]);
    // And the mirror image, forged the other way.
    expect(
      registry.getScopedTools(
        {
          organizationId: beta.organizationId,
          projectId: beta.projectId,
          environmentId: alpha.environmentId,
        } as any,
        { enabledOnly: false },
      ),
    ).toEqual([]);
  });

  it("`setToolEnabled` is refused for the forged triple, and the real row is untouched", async () => {
    const registry = new ToolRegistryService(prisma as any, undefined as any);
    await registry.rebuildIndex();

    // The control: the coherent write lands, so the refusal below is about the
    // triple rather than about the method being broken.
    expect(
      await registry.setToolEnabled(
        {
          organizationId: alpha.organizationId,
          projectId: alpha.projectId,
          environmentId: alpha.environmentId,
        } as any,
        alpha.externalId,
        "alpha.create_issue",
        false,
      ),
    ).toBe(true);
    expect(
      (
        await prisma.environmentEntityTool.findUniqueOrThrow({
          where: {
            environmentId_entityId_toolId: {
              environmentId: alpha.environmentId,
              entityId: alpha.entityId,
              toolId,
            },
          },
        })
      ).enabled,
    ).toBe(false);

    // The forged triple is refused BY THE CACHE — which never held a bucket for
    // it, because `rebuildIndex` mints its keys from row ancestry rather than
    // from a caller's claim — and not by the write, which has no tenancy join.
    expect(
      await registry.setToolEnabled(
        {
          organizationId: alpha.organizationId,
          projectId: alpha.projectId,
          environmentId: beta.environmentId,
        } as any,
        alpha.externalId,
        "alpha.create_issue",
        true,
      ),
    ).toBe(false);
    // A refusal that still wrote is not a refusal.
    expect(
      (
        await prisma.environmentEntityTool.findUniqueOrThrow({
          where: {
            environmentId_entityId_toolId: {
              environmentId: alpha.environmentId,
              entityId: alpha.entityId,
              toolId,
            },
          },
        })
      ).enabled,
    ).toBe(false);
  });

  it("the registry's own ancestry `continue` is defence in depth, exercised where the store cannot reach", async () => {
    // THE ONE CASE THAT CANNOT USE THE REAL STORE, AND THAT IS THE POINT. The
    // trigger makes the incoherent row unrepresentable, so the only way to
    // exercise `rebuildIndex`'s `if (entity.projectId !== environment.projectId)
    // continue;` is to hand it a client that can produce one. Deleting that line
    // makes THIS case fail and leaves every database-backed case above green,
    // which is exactly why both halves exist: the store proves the rule holds
    // today, and this proves the application would still refuse if it did not.
    const incoherent = {
      environmentEntityTool: {
        findMany: async () => [
          {
            id: "mapping-x",
            environmentId: beta.environmentId,
            entityId: alpha.entityId,
            toolId,
            enabled: true,
            callbackUrl: "https://alpha.example/tools",
            tool: {
              id: toolId,
              name: "alpha.create_issue",
              description: "Create an issue",
              paramSchema: { type: "object" },
              category: null,
            },
            entity: {
              id: alpha.entityId,
              externalId: alpha.externalId,
              projectId: alpha.projectId, // alpha's tree
              connectionKind: "wire",
              project: { organizationId: alpha.organizationId },
              mcpConfig: null,
              mcpClient: null,
            },
            environment: { projectId: beta.projectId }, // beta's tree
          },
        ],
      },
      agentBinding: { findMany: async () => [] },
    };
    const registry = new ToolRegistryService(incoherent as any, undefined as any);
    await registry.rebuildIndex();

    // The scope key such a row WOULD mint: organization and project from the
    // entity, environment from the mapping — a triple belonging to no tenant.
    expect(
      registry.getScopedTools(
        {
          organizationId: alpha.organizationId,
          projectId: alpha.projectId,
          environmentId: beta.environmentId,
        } as any,
        { enabledOnly: false },
      ),
    ).toEqual([]);
    // ...and neither coherent triple sees it either, which is what "dropped"
    // has to mean: not re-filed somewhere safer, gone.
    expect(
      registry.getScopedTools(
        {
          organizationId: alpha.organizationId,
          projectId: alpha.projectId,
          environmentId: alpha.environmentId,
        } as any,
        { enabledOnly: false },
      ),
    ).toEqual([]);
    expect(
      registry.getScopedTools(
        {
          organizationId: beta.organizationId,
          projectId: beta.projectId,
          environmentId: beta.environmentId,
        } as any,
        { enabledOnly: false },
      ),
    ).toEqual([]);
  });
});
