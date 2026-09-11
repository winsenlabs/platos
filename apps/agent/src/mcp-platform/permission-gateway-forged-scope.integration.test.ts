/**
 * WIN-268 (M4.2) — THE TIER-2 FORGED-SCOPE REFUSAL, AGAINST A REAL DATABASE.
 *
 * WHAT SEPARATES THIS FROM A TENANCY TEST THAT PASSES EITHER WAY. A two-tenant
 * test is not automatically a tenancy test. Give the gateway tenant B's COHERENT
 * scope and the buggy code and the fixed code answer identically — B genuinely
 * has no policy for that tool, so abstaining is correct. The case that tells them
 * apart is the FORGED triple: three ids that are each real and that do not form a
 * chain. `{ organizationId: B.org, projectId: A.project, environmentId: A.env }`
 * asks the gateway about A's environment while claiming B's organization, and the
 * old tier 2 answered by reading B's (empty) policy set and abstaining — so
 * every `block` A had written went unconsulted.
 *
 * WHY A REAL DATABASE. The whole defect is a WHERE clause: `organizationId:
 * scope.organizationId` with nothing joining it to the environment. A doubled
 * client returns whatever the double was told to return for any where-clause, so
 * a unit suite proves nothing about which rows PostgreSQL would have handed back.
 * `permission-gateway.service.test.ts` doubles `organizationMcpPolicy.findMany`
 * and was green throughout.
 *
 * THE POSITIVE CONTROL IS THE OTHER HALF. Without a case where the COHERENT scope
 * finds A's `block`, "refuse everything" would pass every assertion below.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@platos/tenancy-database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MCPPermissionGatewayService } from "./permission-gateway.service";

// NO `DATABASE_URL` FALLBACK. `apps/agent/test/setup.ts` stamps a fake URL into
// every worker so unit tests can read `env.*` with no database; a suite that fell
// back to it would find a truthy URL, decide it had a database, and turn a skip
// into a red on every machine without PostgreSQL.
const baseDatabaseUrl =
  process.env.MCP_FORGED_SCOPE_TEST_DATABASE_URL ??
  process.env.PLATOS_POSTGRES_INTEGRATION_DATABASE_URL;

if (process.env.MCP_FORGED_SCOPE_REQUIRED === "1" && !baseDatabaseUrl) {
  throw new Error("MCP_FORGED_SCOPE_REQUIRED=1 but no database URL is set");
}

const describeWithDatabase = baseDatabaseUrl ? describe : describe.skip;
const { Client } = require("pg") as { Client: new (options: unknown) => any };

interface Tenant {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly userId: string;
}

/** The tool tenant A blocks at tier 2, and nobody blocks at tier 1. */
const GUARDED_TOOL = "threads.list";

describeWithDatabase("tier-2 MCP policy refuses a forged organization/project/environment chain", () => {
  let admin: any;
  let adminConnected = false;
  let prisma: PrismaClient;
  let schemaName: string;
  let gateway: MCPPermissionGatewayService;
  let alpha: Tenant;
  let beta: Tenant;

  async function seedTenant(label: string): Promise<Tenant> {
    const user = await prisma.user.create({
      data: { email: `${schemaName}-${label}@test.invalid`, displayName: `${label} operator` },
    });
    const organization = await prisma.organization.create({
      data: { slug: `${schemaName}-${label}`, name: `${label} org` },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: organization.id, userId: user.id, role: "OWNER" },
    });
    const project = await prisma.project.create({
      data: { organizationId: organization.id, slug: `${schemaName}-${label}`, name: `${label} project` },
    });
    const environment = await prisma.environment.create({
      data: { projectId: project.id, slug: "development", name: "Development" },
    });
    return {
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      userId: user.id,
    };
  }

  beforeAll(async () => {
    schemaName = `mcpforge_${process.pid}_${Date.now()}`;
    admin = new Client({ connectionString: baseDatabaseUrl });
    await admin.connect();
    adminConnected = true;

    const migrationsRoot = resolve(
      process.cwd(),
      "../../internal-packages/tenancy-database/prisma/migrations",
    );
    for (const migration of readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()) {
      await admin.query(
        readFileSync(resolve(migrationsRoot, migration, "migration.sql"), "utf8")
          .replaceAll('"public"', `"${schemaName}"`),
      );
    }

    const url = new URL(baseDatabaseUrl!);
    url.searchParams.set("schema", schemaName);
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });

    alpha = await seedTenant("alpha");
    beta = await seedTenant("beta");

    // ONLY TENANT ALPHA WRITES A POLICY. Beta has none, which is what makes its
    // coherent scope legitimately abstain and therefore useless as a control.
    await prisma.organizationMcpPolicy.create({
      data: { organizationId: alpha.organizationId, pattern: GUARDED_TOOL, effect: "DENY" },
    });

    gateway = new MCPPermissionGatewayService(prisma as never);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (adminConnected) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.end();
    }
  });

  it("POSITIVE CONTROL: alpha's coherent scope finds alpha's tier-2 block", async () => {
    // Without this, "block everything" satisfies every case below.
    const decision = await gateway.resolve({
      scope: {
        organizationId: alpha.organizationId,
        projectId: alpha.projectId,
        environmentId: alpha.environmentId,
      },
      agentId: null,
      userId: alpha.userId,
      toolName: GUARDED_TOOL,
    });
    expect(decision.state).toBe("block");
    expect(decision.tier).toBe(2);
    expect(decision.reason).toBe("org-policy block");
  });

  it("NEGATIVE CONTROL: an unguarded tool in the same coherent scope is allowed", async () => {
    // Proves tier 2 is reading the PATTERN and not simply refusing alpha.
    const decision = await gateway.resolve({
      scope: {
        organizationId: alpha.organizationId,
        projectId: alpha.projectId,
        environmentId: alpha.environmentId,
      },
      agentId: null,
      userId: alpha.userId,
      toolName: "threads.get",
    });
    expect(decision.state).toBe("auto_allow");
  });

  it("A COHERENT FOREIGN SCOPE STILL ABSTAINS, and that is why it proves nothing", async () => {
    // Beta's own chain is real and beta has written no policy, so `auto_allow` is
    // the CORRECT answer here and was the answer before this fix too. This case
    // exists to be explicit that the two-tenant shape on its own is not the test.
    const decision = await gateway.resolve({
      scope: {
        organizationId: beta.organizationId,
        projectId: beta.projectId,
        environmentId: beta.environmentId,
      },
      agentId: null,
      userId: beta.userId,
      toolName: GUARDED_TOOL,
    });
    expect(decision.state).toBe("auto_allow");
  });

  it("THE FORGED CHAIN: beta's organization over alpha's environment is REFUSED", async () => {
    // THE CASE THE DEFECT PASSED. Every id is real. The chain is not. The old
    // tier 2 read beta's policy set for alpha's environment, found nothing, and
    // abstained — so alpha's DENY was never consulted and the call was allowed.
    const decision = await gateway.resolve({
      scope: {
        organizationId: beta.organizationId,
        projectId: alpha.projectId,
        environmentId: alpha.environmentId,
      },
      agentId: null,
      userId: alpha.userId,
      toolName: GUARDED_TOOL,
    });
    expect(decision.state).toBe("block");
    expect(decision.tier).toBe(2);
    // THE REASON MATTERS. `org-policy block` would mean the fix accidentally
    // found alpha's row; the refusal must be about the CHAIN.
    expect(decision.reason).toBe("scope project-outside-claimed-organization");
  });

  it("THE FORGED CHAIN REFUSES AN UNGUARDED TOOL TOO", async () => {
    // The refusal is a property of the SCOPE, not of the tool. A fix that only
    // blocked the guarded tool would leave every other tool answerable for a
    // tenant the caller never named coherently.
    const decision = await gateway.resolve({
      scope: {
        organizationId: beta.organizationId,
        projectId: alpha.projectId,
        environmentId: alpha.environmentId,
      },
      agentId: null,
      userId: alpha.userId,
      toolName: "threads.get",
    });
    expect(decision.state).toBe("block");
    expect(decision.reason).toBe("scope project-outside-claimed-organization");
  });

  it("A REAL ENVIRONMENT ADDRESSED THROUGH THE WRONG PROJECT has its own reason", async () => {
    // Distinct codes: two guards answering the same code cannot be told apart in
    // an audit line, and this cause is not the one above.
    const decision = await gateway.resolve({
      scope: {
        organizationId: alpha.organizationId,
        projectId: beta.projectId,
        environmentId: alpha.environmentId,
      },
      agentId: null,
      userId: alpha.userId,
      toolName: GUARDED_TOOL,
    });
    expect(decision.state).toBe("block");
    expect(decision.reason).toBe("scope environment-outside-claimed-project");
  });

  it("AN ENVIRONMENT ID THAT IS NOT AN ENVIRONMENT has its own reason", async () => {
    const decision = await gateway.resolve({
      scope: {
        organizationId: alpha.organizationId,
        projectId: alpha.projectId,
        environmentId: randomUUID(),
      },
      agentId: null,
      userId: alpha.userId,
      toolName: GUARDED_TOOL,
    });
    expect(decision.state).toBe("block");
    expect(decision.reason).toBe("scope environment-not-found");
  });

  it("TIER 3 WAS ALREADY JOINED, and the forged chain still cannot reach an agent binding", async () => {
    // Recorded rather than assumed: `readAgentOverride`'s where-clause already
    // walked `environment -> project -> organization`, which is the asymmetry
    // that showed tier 2's missing join was an oversight. This case pins that
    // tier 3 is unchanged by the fix — with an agentId supplied, the answer is a
    // block whichever tier reaches it first.
    const decision = await gateway.resolve({
      scope: {
        organizationId: beta.organizationId,
        projectId: alpha.projectId,
        environmentId: alpha.environmentId,
      },
      agentId: randomUUID(),
      userId: alpha.userId,
      toolName: "threads.get",
    });
    expect(decision.state).toBe("block");
  });

  // THE TWO CRUD CASES THAT STOOD HERE ARE GONE WITH THE CODE THEY COVERED.
  //
  // WIN-268 (M4.2) deleted `listOrgPolicies`, `upsertOrgPolicy` and
  // `deleteOrgPolicy` from `permission-gateway.service.ts`: nothing called them,
  // and the tier-2 MANAGEMENT surface is now
  // `ToolsContract.listOrganizationPolicies` / `setOrganizationPolicy` /
  // `deleteOrganizationPolicy`, served by
  // `apps/core-api/src/transports/mcp/organization-policies.controller.ts`.
  //
  // THE GUARANTEE MOVED WITH IT RATHER THAN BEING DROPPED. Its replacement is
  // `apps/core-api/src/composition/mcp-organization-policy.integration.test.ts`,
  // which asks the same question of the contract path against a real tree — a
  // forged authorization, a forged triple, an environment that is not one, and
  // the `metadata`-vs-`secret:mutate` narrowing — with a distinct refusal code
  // for each and a positive control for each refusal.
  //
  // WHAT REMAINS BELOW is `resolve`'s tier-2 join, which `tool-executor.service.ts`
  // in this deployable still reaches. Those ORM sites are still on the register.
});
