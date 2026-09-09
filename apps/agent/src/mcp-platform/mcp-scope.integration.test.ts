// WIN-268 P2 — the MCP authorization surfaces' refusals, against a REAL
// PostgreSQL, with TWO TENANTS and a FORGED TRIPLE.
//
// ---------------------------------------------------------------------------
// WHY A COHERENT TWO-TENANT CASE WOULD HAVE PROVED NOTHING
//
// Give tenant A's operator tenant A's whole triple and tenant B's operator
// tenant B's, and every version of this code passes — including the version
// with no ancestry check at all — because a `where` keyed on the leaf alone
// already separates two tenants whose leaves differ. A two-tenant test is not
// automatically a tenancy test.
//
// The case that separates them is the FORGED triple: an environment from tenant
// A carried under tenant B's organization id. `apps/agent/src/auth/scope.guard.ts`
// assembles `RequestScope` from three unrelated request headers —
// `x-platos-organization-id`, `x-platos-project-id`, `x-platos-environment-id` —
// and joins them only when `x-platos-agent-id` is also present. So the forged
// triple is not hypothetical; it is what that guard admits.
//
// AND THE DEFECT IT EXPOSES IS AN ESCALATION, NOT A LEAK. `readOrgPolicy` used
// to read `where: { organizationId: scope.organizationId }`. Point it at an
// organization with NO policy rows and it answers `[]`; `[]` means "no pattern
// matched" means "this tier has no objection". So a caller sitting under a
// tenant that DENIES a tool could escape that denial by naming a second tenant's
// organization id — a tier that can only tighten, made to abstain. Case 3 below
// runs the extraction source's own statement against these rows and shows the
// empty answer, then shows the current code refusing. That is the join to
// something outside this file: the defect is demonstrated on real rows rather
// than asserted in prose.
//
// ---------------------------------------------------------------------------
// IT FAILS WHEN DOCKER IS ABSENT RATHER THAN SKIPPING, for the reason
// `packages/adapters/postgres-tenancy/src/harness.ts` gives: a skipped
// integration suite and a passing one look identical in a CI summary, and this
// suite IS the evidence.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "@platos/tenancy-database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EntityToolPolicyStore } from "./entity-tool-policy.store";
import { McpIdentityStore } from "./mcp-identity.store";
import { McpPolicyStore } from "./mcp-policy.store";
import { MCPPermissionGatewayService, McpScopeRefusedError } from "./permission-gateway.service";
import { MCP_SCOPE_FOREIGN, MCP_SCOPE_UNKNOWN, type ClaimedScope } from "./mcp-scope";

// A container start plus a `migrate deploy` is minutes, not seconds, on a
// hosted runner.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const AGENT_ROOT = resolve(__dirname, "../..");
const DATABASE_PACKAGE = resolve(AGENT_ROOT, "../../internal-packages/tenancy-database");
const PRISMA_BINARY = resolve(AGENT_ROOT, "../../node_modules/.bin/prisma");

interface Tenant {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly entityId: string;
  readonly toolId: string;
  readonly mappingId: string;
  readonly scope: ClaimedScope;
}

let container: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let alpha: Tenant;
let beta: Tenant;

async function seedTenant(label: string): Promise<Tenant> {
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const entityId = randomUUID();
  const toolId = randomUUID();
  const mappingId = randomUUID();

  await prisma.organization.create({
    data: { id: organizationId, slug: `${label}-org`, name: `${label} org` },
  });
  await prisma.project.create({
    data: { id: projectId, organizationId, slug: `${label}-proj`, name: `${label} project` },
  });
  await prisma.environment.create({
    data: { id: environmentId, projectId, slug: `${label}-env`, name: `${label} environment` },
  });
  await prisma.entity.create({
    data: {
      id: entityId,
      projectId,
      externalId: `${label}-entity`,
      displayName: `${label} entity`,
      connectionStatus: "connected",
      connectionKind: "mcp",
    },
  });
  await prisma.entityMcpConfig.create({
    data: { entityId, enabled: true, identityMode: "bearer+anonymous" },
  });
  await prisma.tool.create({
    data: {
      id: toolId,
      name: `reports.get`,
      description: `${label} report reader`,
      paramSchema: {},
      schemaHash: `hash-${label}`,
    },
  });
  await prisma.environmentEntityTool.create({
    data: { id: mappingId, environmentId, entityId, toolId, enabled: true },
  });

  return {
    organizationId,
    projectId,
    environmentId,
    entityId,
    toolId,
    mappingId,
    scope: { organizationId, projectId, environmentId },
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  const databaseUrl = container.getConnectionUri();
  execFileSync(PRISMA_BINARY, ["migrate", "deploy", "--schema", resolve(DATABASE_PACKAGE, "prisma/schema.prisma")], {
    cwd: DATABASE_PACKAGE,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
  prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  await prisma.$connect();
  alpha = await seedTenant("alpha");
  beta = await seedTenant("beta");

  // TENANT ALPHA DENIES `reports.*`. TENANT BETA HAS NO POLICY AT ALL — which
  // is what makes beta's organization id a useful thing for an alpha caller to
  // forge, and is therefore the whole point of the fixture.
  await prisma.organizationMcpPolicy.create({
    data: { organizationId: alpha.organizationId, pattern: "reports.*", effect: "DENY" },
  });
}, 300_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
});

/** The forged triple: alpha's environment and project, beta's organization. */
function forged(): ClaimedScope {
  return {
    organizationId: beta.organizationId,
    projectId: alpha.projectId,
    environmentId: alpha.environmentId,
  };
}

describe("WIN-268 P2 — the four-tier gate's refusals against real PostgreSQL", () => {
  it("COHERENT: each tenant sees its own tier-2 answer, and this case passes either way", async () => {
    const gateway = new MCPPermissionGatewayService(new McpPolicyStore(prisma));

    await expect(
      gateway.resolve({ scope: alpha.scope, agentId: null, userId: null, toolName: "reports.get" }),
    ).resolves.toEqual({ state: "block", tier: 2, reason: "org-policy block" });

    await expect(
      gateway.resolve({ scope: beta.scope, agentId: null, userId: null, toolName: "reports.get" }),
    ).resolves.toMatchObject({ state: "auto_allow" });

    // Stated so the next reader does not mistake the above for the tenancy
    // proof: a `where` keyed on `organizationId` alone already separates these
    // two, so a build with NO ancestry check passes this case. The next one is
    // the one that does the work.
  });

  it("FORGED: alpha's environment under beta's organization is REFUSED, not answered", async () => {
    const store = new McpPolicyStore(prisma);
    const gateway = new MCPPermissionGatewayService(store);

    const refused = await store.listOrganizationPolicies(forged());
    expect(refused).toEqual({ ok: false, reason: MCP_SCOPE_FOREIGN });

    await expect(
      gateway.resolve({ scope: forged(), agentId: null, userId: null, toolName: "reports.get" }),
    ).resolves.toEqual({ state: "block", tier: 2, reason: `scope ${MCP_SCOPE_FOREIGN}` });
  });

  it("FORGED, THE DISCRIMINATOR: the pre-P2 statement ESCAPES alpha's deny on these same rows", async () => {
    // The extraction source's own read, verbatim, run against the fixture.
    // This is not a re-implementation for the sake of an assertion: it is the
    // statement that shipped, and it is here so the defect is demonstrated on
    // real rows rather than described.
    const asShipped = await prisma.organizationMcpPolicy.findMany({
      where: { organizationId: forged().organizationId },
      select: { pattern: true, effect: true },
    });

    // An EMPTY RESULT. Not an error, not a refusal — nothing matched, because
    // beta has no policies, and the caller is standing in alpha's environment.
    expect(asShipped).toEqual([]);

    // And an empty tier-2 answer is an ABSTENTION, so the tool alpha DENIES
    // would have resolved `auto_allow`. That is the escalation.
    const alphaDenied = await prisma.organizationMcpPolicy.findMany({
      where: { organizationId: alpha.organizationId },
      select: { pattern: true, effect: true },
    });
    expect(alphaDenied).toEqual([{ pattern: "reports.*", effect: "DENY" }]);

    // The current code refuses instead. THE REFUSAL IS THE POINT: it is not
    // that the answer is empty, it is that there is no answer.
    const gateway = new MCPPermissionGatewayService(new McpPolicyStore(prisma));
    const resolved = await gateway.resolve({
      scope: forged(),
      agentId: null,
      userId: null,
      toolName: "reports.get",
    });
    expect(resolved.state).toBe("block");
    expect(resolved.state).not.toBe("auto_allow");
  });

  it("distinguishes a forged ancestry from an environment that does not exist", async () => {
    const store = new McpPolicyStore(prisma);

    await expect(
      store.listOrganizationPolicies({ ...alpha.scope, environmentId: randomUUID() }),
    ).resolves.toEqual({ ok: false, reason: MCP_SCOPE_UNKNOWN });

    // A NON-UUID leaf is `unknown_environment` too, and it must not raise.
    // The id arrives as a raw HTTP header, so `::uuid` in the resolver's join
    // would turn `x-platos-environment-id: not-a-uuid` into a PostgreSQL 22P02
    // and a 500 — which is a worse answer than the 403 a forged scope earned.
    await expect(
      store.listOrganizationPolicies({ ...alpha.scope, environmentId: "not-a-uuid" }),
    ).resolves.toEqual({ ok: false, reason: MCP_SCOPE_UNKNOWN });
  });

  it("refuses every WRITE on a forged scope, including the delete that used to answer false", async () => {
    const gateway = new MCPPermissionGatewayService(new McpPolicyStore(prisma));

    await expect(gateway.listOrgPolicies(forged())).rejects.toThrow(McpScopeRefusedError);
    await expect(gateway.upsertOrgPolicy(forged(), "secrets.*", "block")).rejects.toThrow(
      McpScopeRefusedError,
    );
    await expect(gateway.deleteOrgPolicy(forged(), randomUUID())).rejects.toThrow(
      McpScopeRefusedError,
    );

    // AND NOTHING WAS WRITTEN. A refusal that still left a row would be a
    // refusal in name only, so the count is read back rather than assumed.
    const betaPolicies = await prisma.organizationMcpPolicy.count({
      where: { organizationId: beta.organizationId },
    });
    expect(betaPolicies).toBe(0);
  });

  it("the coherent write path still works, so the refusal is not a blanket outage", async () => {
    const gateway = new MCPPermissionGatewayService(new McpPolicyStore(prisma));
    const created = await gateway.upsertOrgPolicy(beta.scope, "secrets.*", "block");
    expect(created.policy).toBe("block");

    await expect(gateway.deleteOrgPolicy(beta.scope, created.id)).resolves.toBe(true);
    // "no such row" is still `false`, and it is NOT the same value a forged
    // scope produces — that is the distinction the extraction source could not
    // make, because it answered `false` for both.
    await expect(gateway.deleteOrgPolicy(beta.scope, randomUUID())).resolves.toBe(false);
  });
});

describe("WIN-268 P2 — the entity tool ACL's refusals against real PostgreSQL", () => {
  it("COHERENT: each tenant pages only its own exposures", async () => {
    const store = new EntityToolPolicyStore(prisma);

    const alphaPage = await store.pageExposures(alpha.scope, alpha.entityId, { limit: 50, offset: 0 });
    expect(alphaPage.ok).toBe(true);
    expect(alphaPage.ok && alphaPage.value.exposures.map((row) => row.id)).toEqual([alpha.mappingId]);

    const betaPage = await store.pageExposures(beta.scope, beta.entityId, { limit: 50, offset: 0 });
    expect(betaPage.ok && betaPage.value.exposures.map((row) => row.id)).toEqual([beta.mappingId]);
  });

  it("FORGED: the exposure page is refused, and the refusal is not an empty page", async () => {
    const store = new EntityToolPolicyStore(prisma);
    const page = await store.pageExposures(forged(), alpha.entityId, { limit: 50, offset: 0 });
    expect(page).toEqual({ ok: false, reason: MCP_SCOPE_FOREIGN });

    // The discriminator, again on real rows: the pre-P2 statement — keyed on
    // `{ entityId, environmentId }` with no ancestry — answers alpha's real
    // exposure to a caller claiming beta's organization.
    const asShipped = await prisma.environmentEntityTool.findMany({
      where: { entityId: alpha.entityId, environmentId: alpha.environmentId, enabled: true },
      select: { id: true },
    });
    expect(asShipped).toEqual([{ id: alpha.mappingId }]);
  });

  it("FORGED: every scoped write is refused and leaves no row behind", async () => {
    const store = new EntityToolPolicyStore(prisma);

    await expect(
      store.savePolicy(forged(), alpha.entityId, alpha.toolId, "attacker", {
        effect: "ALLOW",
        minIdentityMode: "bearer",
        scopeLabels: ["mcp:tools"],
      }, {}),
    ).resolves.toEqual({ ok: false, reason: MCP_SCOPE_FOREIGN });

    await expect(
      store.savePolicies(forged(), alpha.entityId, [alpha.toolId], {
        effect: "ALLOW",
        minIdentityMode: "bearer",
        scopeLabels: ["mcp:tools"],
        addedBy: "attacker",
      }, {}),
    ).resolves.toEqual({ ok: false, reason: MCP_SCOPE_FOREIGN });

    await expect(
      store.toolIdsForMappings(forged(), alpha.entityId, [alpha.mappingId]),
    ).resolves.toEqual({ ok: false, reason: MCP_SCOPE_FOREIGN });

    expect(
      await prisma.entityToolPolicy.count({ where: { entityId: alpha.entityId } }),
    ).toBe(0);
  });

  it("the coherent write path still works and the exposure becomes visible", async () => {
    const store = new EntityToolPolicyStore(prisma);
    const saved = await store.savePolicy(beta.scope, beta.entityId, beta.toolId, "operator", {
      effect: "ALLOW",
      minIdentityMode: "bearer",
      scopeLabels: ["mcp:tools"],
    }, {});
    expect(saved.ok).toBe(true);

    const rows = await store.listAllowedPoliciesForVerifiedEnvironment(
      beta.environmentId,
      beta.entityId,
      "reports.get",
    );
    expect(rows.map((row) => row.toolId)).toEqual([beta.toolId]);

    // And the verified-environment read is still keyed on the environment the
    // CREDENTIAL names: alpha's environment sees none of beta's policies.
    const foreign = await store.listAllowedPoliciesForVerifiedEnvironment(
      alpha.environmentId,
      beta.entityId,
      "reports.get",
    );
    expect(foreign).toEqual([]);
  });
});

describe("WIN-268 P2 — the identity resolver's pre-existing ancestry check, confirmed", () => {
  it("an environment from the OTHER tenant is not resolvable for this entity", async () => {
    const store = new McpIdentityStore(prisma);

    // The coherent case answers.
    await expect(
      store.findActiveEnvironmentForEntity(alpha.entityId, alpha.environmentId),
    ).resolves.toBe(alpha.environmentId);

    // The cross-tenant case does not — and this is a check the extraction
    // source ALREADY had (`project: { entities: { some: { id: entityId } } }`).
    // It is asserted rather than "fixed", because reporting a hole that is not
    // there would be worse than missing one that is.
    await expect(
      store.findActiveEnvironmentForEntity(alpha.entityId, beta.environmentId),
    ).resolves.toBeNull();
  });

  it("an archived environment is not resolvable either", async () => {
    const store = new McpIdentityStore(prisma);
    await prisma.environment.update({
      where: { id: beta.environmentId },
      data: { archivedAt: new Date("2026-09-01T00:00:00.000Z") },
    });
    await expect(
      store.findActiveEnvironmentForEntity(beta.entityId, beta.environmentId),
    ).resolves.toBeNull();
    await prisma.environment.update({
      where: { id: beta.environmentId },
      data: { archivedAt: null },
    });
  });
});
