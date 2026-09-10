/**
 * THE UNGUARDED CROSS-TENANT DELETE, AND THE PROOF THAT THE PATH THAT SURVIVED
 * IT REFUSES A FORGED SCOPE TRIPLE.
 *
 * WHAT WAS WRONG. `ToolRegistryService.reconcileEntityTools` deleted
 * `EnvironmentEntityTool` rows selected by `{ entityId, environmentId }` and
 * nothing else — no organization, no project, and no join to either. That pair
 * is the whole key of the table, so a caller holding two identifiers it had not
 * earned could delete another tenant's tool exposures. Four consecutive stages
 * named it; none fixed it, because it sat outside their roots.
 *
 * WHAT WAS DONE, AND WHY THAT AND NOT A GUARD. Nothing called it. The banner in
 * `tool-registry.service.ts` records the measurement; the short version is that
 * `EntityMcpDiscoveryService` calls `registerTools` and nothing else, and
 * registration is idempotent-REPLACE — it prunes inside its own transaction,
 * after resolving BOTH ancestors. A second prune with no tenancy join was not a
 * fallback, it was a hole, and an unwatched hole is worse than a watched one. So
 * the method is deleted and this suite proves the survivor.
 *
 * WHY THE SCOPE IS FORGED AND NOT MERELY FOREIGN. A coherent foreign scope —
 * beta's organization, beta's project, beta's environment, asking about beta's
 * own entity — is refused by ANY implementation, including the deleted one,
 * because the rows it names are not alpha's. It therefore separates nothing. The
 * FORGED triple is the one `apps/agent/src/auth/scope.guard.ts` actually admits:
 * three identifiers read from three INDEPENDENT headers, each real, belonging to
 * two different tenants. That is the input the deleted method would have
 * honoured and the input `registerTools` must refuse.
 *
 * WHY A DOUBLE COULD NOT ESTABLISH IT. Every refusal below is a `findFirst` that
 * has to MISS across a real relation graph — `Entity -> Project -> Organization`
 * and `Environment -> Project -> Organization` — and every "the rows are
 * untouched" assertion is a re-read of committed state. A `vi.fn()` client
 * answers whatever the fixture says, so it would agree with a version of
 * `registerTools` that had no `where` clause at all.
 *
 * THE LAST TWO CASES NEED NO DATABASE and are deliberately outside the gated
 * `describe`: they are the structural half — that no delete survives in that
 * file outside a function which resolves both ancestors first, and that the
 * deleted method is not back — and they must run wherever this file runs.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@platos/tenancy-database";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolRegistryService } from "./tool-registry.service";

// NO `DATABASE_URL` FALLBACK, for the reason
// `registry-incoherent-pair-postgres.integration.test.ts` states beside this
// file: `apps/agent/test/setup.ts` stamps a fake URL into every worker so unit
// tests can read `env.*`, and a suite that fell back to it would find a truthy
// URL, decide it had a database, and fail `beforeAll` with `role "test" does not
// exist` on every machine without PostgreSQL — turning a SKIP into a RED.
const baseDatabaseUrl =
  process.env.TOOL_REGISTRY_TENANCY_TEST_DATABASE_URL ??
  process.env.PLATOS_POSTGRES_INTEGRATION_DATABASE_URL;

// A SKIP HAS TO BE VISIBLE. This repository has the scar: a tranche reported
// 218/218 with the suites that mattered silently skipped, and merged two
// regressions. The CI job that runs this file sets this, so a run that MEANT to
// prove the refusal gets a failure instead of a green.
if (process.env.TOOL_REGISTRY_TENANCY_REQUIRED === "1" && !baseDatabaseUrl) {
  throw new Error(
    "TOOL_REGISTRY_TENANCY_REQUIRED=1 but no database URL is set; " +
      "export TOOL_REGISTRY_TENANCY_TEST_DATABASE_URL or PLATOS_POSTGRES_INTEGRATION_DATABASE_URL",
  );
}

const describeWithDatabase = baseDatabaseUrl ? describe : describe.skip;

/** The two refusals `registerTools` can mint, as it spells them. */
const ENTITY_REFUSAL = "entity_not_found_in_scope";
const ENVIRONMENT_REFUSAL = "environment_not_found_in_scope";

interface Tenant {
  organizationId: string;
  projectId: string;
  environmentId: string;
  entityId: string;
  externalId: string;
}

function declaration(names: string[]) {
  return names.map((name) => ({
    name,
    description: `${name} description`,
    paramSchema: { type: "object", properties: {} } as Record<string, unknown>,
  }));
}

describeWithDatabase("the surviving prune path against a forged scope triple", () => {
  let admin: any;
  let adminConnected = false;
  let prisma: PrismaClient;
  let schemaName: string;
  let alpha: Tenant;
  let beta: Tenant;
  let registry: ToolRegistryService;

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
    };
  }

  /** The rows the forged calls must not be able to touch, as committed state. */
  async function alphaExposures() {
    const rows = await prisma.environmentEntityTool.findMany({
      where: { entityId: alpha.entityId, environmentId: alpha.environmentId },
      select: { id: true, toolId: true, enabled: true, tool: { select: { name: true } } },
      orderBy: { id: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      toolId: row.toolId,
      enabled: row.enabled,
      name: row.tool.name,
    }));
  }

  beforeAll(async () => {
    schemaName = `toolforge_${process.pid}_${Date.now()}`;
    const { Client } = require("pg") as { Client: new (options: unknown) => any };
    admin = new Client({ connectionString: baseDatabaseUrl });
    await admin.connect();
    adminConnected = true;

    // EVERY migration, in order, from the canonical directory — the same schema
    // production runs, including the ancestry trigger the later migration
    // redefines. A fixture built from the initial migration alone would be
    // proving enforcement production no longer has.
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
      await admin.query(
        readFileSync(resolve(migrationsRoot, migration, "migration.sql"), "utf8").replaceAll(
          '"public"',
          `"${schemaName}"`,
        ),
      );
    }

    const url = new URL(baseDatabaseUrl!);
    url.searchParams.set("schema", schemaName);
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });

    alpha = await seedTenant("alpha");
    beta = await seedTenant("beta");
    registry = new ToolRegistryService(prisma as any, undefined as any);

    // Alpha's real exposures, written the only way anything writes them.
    await registry.registerTools(
      {
        organizationId: alpha.organizationId,
        projectId: alpha.projectId,
        environmentId: alpha.environmentId,
        entityPk: alpha.entityId,
        sourceEntityId: alpha.externalId,
      },
      declaration(["alpha.create_issue", "alpha.close_issue"]),
      null,
    );
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect().catch(() => undefined);
    if (adminConnected) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });

  it("POSITIVE CONTROL: the coherent triple PRUNES, so the refusals below are about the scope", async () => {
    // Without this the whole file is satisfied by a `registerTools` that refuses
    // everything, and "the forged triple was refused" would prove nothing at all.
    const before = await alphaExposures();
    expect(before.map((row) => row.name).sort()).toEqual([
      "alpha.close_issue",
      "alpha.create_issue",
    ]);

    const result = await registry.registerTools(
      {
        organizationId: alpha.organizationId,
        projectId: alpha.projectId,
        environmentId: alpha.environmentId,
        entityPk: alpha.entityId,
        sourceEntityId: alpha.externalId,
      },
      declaration(["alpha.create_issue"]),
      null,
    );
    // THE PRUNE THE DELETED METHOD EXISTED TO PERFORM, performed here.
    expect(result.removed).toBe(1);
    expect((await alphaExposures()).map((row) => row.name)).toEqual(["alpha.create_issue"]);

    // Put the second exposure back so every later case starts from two rows.
    await registry.registerTools(
      {
        organizationId: alpha.organizationId,
        projectId: alpha.projectId,
        environmentId: alpha.environmentId,
        entityPk: alpha.entityId,
        sourceEntityId: alpha.externalId,
      },
      declaration(["alpha.create_issue", "alpha.close_issue"]),
      null,
    );
    expect(await alphaExposures()).toHaveLength(2);
  });

  it("THE FORGED TRIPLE: beta's organization and project over alpha's entity is refused, and alpha's rows are byte-identical", async () => {
    const before = await alphaExposures();
    expect(before).toHaveLength(2);

    // The exact input the deleted method would have honoured: alpha's entity
    // primary key and alpha's environment — both real, both learnable — carried
    // under BETA's organization and project. `scope.guard.ts` admits it because
    // it reads the three ids from three independent headers and never checks
    // that they belong to one tree.
    await expect(
      registry.registerTools(
        {
          organizationId: beta.organizationId,
          projectId: beta.projectId,
          environmentId: alpha.environmentId,
          entityPk: alpha.entityId,
          sourceEntityId: alpha.externalId,
        },
        declaration(["beta.injected"]),
        null,
      ),
    ).rejects.toThrow(ENTITY_REFUSAL);

    // A REFUSAL THAT STILL WROTE IS NOT A REFUSAL.
    expect(await alphaExposures()).toEqual(before);
  });

  it("THE EMPTY DECLARATION — the deleted method's whole effect — is refused under the forged triple", async () => {
    const before = await alphaExposures();
    expect(before).toHaveLength(2);

    // An empty list is the `deleteMany` with no survivors: `registerTools`
    // reaches its unconditional prune with `activeMappingIds` empty, which
    // removes every exposure the pair has. It is the closest thing the surviving
    // API has to `reconcileEntityTools(entityPk, environmentId, [])`, so it is
    // the call that must fail hardest under a forged scope.
    await expect(
      registry.registerTools(
        {
          organizationId: beta.organizationId,
          projectId: beta.projectId,
          environmentId: alpha.environmentId,
          entityPk: alpha.entityId,
          sourceEntityId: alpha.externalId,
        },
        [],
        null,
      ),
    ).rejects.toThrow(ENTITY_REFUSAL);
    expect(await alphaExposures()).toEqual(before);

    // AND THE SAME CALL UNDER THE COHERENT TRIPLE REALLY DOES DELETE EVERYTHING,
    // which is what makes the refusal above load-bearing rather than incidental.
    const wiped = await registry.registerTools(
      {
        organizationId: alpha.organizationId,
        projectId: alpha.projectId,
        environmentId: alpha.environmentId,
        entityPk: alpha.entityId,
        sourceEntityId: alpha.externalId,
      },
      [],
      null,
    );
    expect(wiped.removed).toBe(2);
    expect(await alphaExposures()).toEqual([]);

    await registry.registerTools(
      {
        organizationId: alpha.organizationId,
        projectId: alpha.projectId,
        environmentId: alpha.environmentId,
        entityPk: alpha.entityId,
        sourceEntityId: alpha.externalId,
      },
      declaration(["alpha.create_issue", "alpha.close_issue"]),
      null,
    );
    expect(await alphaExposures()).toHaveLength(2);
  });

  it("the ENVIRONMENT half is forged separately, and refuses with its own distinct code", async () => {
    const before = await alphaExposures();

    // Alpha's organization, project and entity, with BETA's environment. The
    // entity resolves, so this case can only be refused by the SECOND join —
    // and two guards returning one code cannot be told apart, which is why the
    // codes are asserted rather than merely the rejection.
    await expect(
      registry.registerTools(
        {
          organizationId: alpha.organizationId,
          projectId: alpha.projectId,
          environmentId: beta.environmentId,
          entityPk: alpha.entityId,
          sourceEntityId: alpha.externalId,
        },
        declaration(["alpha.create_issue"]),
        null,
      ),
    ).rejects.toThrow(ENVIRONMENT_REFUSAL);
    expect(await alphaExposures()).toEqual(before);

    // Beta's own environment is not otherwise poisoned: nothing was written into
    // it either, so the refusal did not merely relocate the write.
    expect(
      await prisma.environmentEntityTool.count({ where: { environmentId: beta.environmentId } }),
    ).toBe(0);
  });

  it("a MISMATCHED externalId under an otherwise coherent triple is refused too", async () => {
    const before = await alphaExposures();
    // `registerTools` joins `externalId` as well as the primary key, so a caller
    // who learned one id but not the other cannot drive the prune. Beta's
    // external id over alpha's primary key is that caller.
    await expect(
      registry.registerTools(
        {
          organizationId: alpha.organizationId,
          projectId: alpha.projectId,
          environmentId: alpha.environmentId,
          entityPk: alpha.entityId,
          sourceEntityId: beta.externalId,
        },
        declaration(["alpha.create_issue"]),
        null,
      ),
    ).rejects.toThrow(ENTITY_REFUSAL);
    expect(await alphaExposures()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// THE STRUCTURAL HALF — no database, so it runs wherever this file runs.
// ---------------------------------------------------------------------------

const SUBJECT = "apps/agent/src/tool-gateway/tool-registry.service.ts";
const GUARDED_MODEL = "environmentEntityTool";
const DESTRUCTIVE_OPERATIONS = new Set(["delete", "deleteMany"]);
/** The two ancestors a scope-verifying resolve must read, as delegate names. */
const REQUIRED_ANCESTOR_DELEGATES = ["entity", "environment"] as const;
/** The fields those resolves must constrain. `organizationId` may be nested. */
const REQUIRED_ANCESTOR_FIELDS = ["organizationId", "projectId"] as const;

interface DestructiveSite {
  readonly line: number;
  readonly enclosing: string;
  readonly guardedBy: readonly string[];
}

/**
 * Every `<receiver>.environmentEntityTool.{delete,deleteMany}(…)` in one source,
 * with the ancestor resolves found in the SAME enclosing function.
 *
 * READ FROM THE AST, NOT FROM A GREP. The receiver is deliberately not pinned:
 * `this.prisma` and a transaction's `tx` are the same reach, and a rule that
 * matched one spelling would be satisfied by renaming the other.
 */
function destructiveSites(sourceText: string, fileName: string): DestructiveSite[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true);
  const sites: DestructiveSite[] = [];

  /** `x.y.z(...)` -> ["y", "z"], for a call whose callee is a property chain. */
  const delegateCall = (node: ts.Node): { model: string; operation: string } | null => {
    if (!ts.isCallExpression(node)) return null;
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee)) return null;
    const receiver = callee.expression;
    if (!ts.isPropertyAccessExpression(receiver)) return null;
    return { model: receiver.name.text, operation: callee.name.text };
  };

  /** The property names anywhere inside an object literal argument. */
  const fieldsOf = (node: ts.Node | undefined): Set<string> => {
    const names = new Set<string>();
    if (!node) return names;
    const walk = (current: ts.Node) => {
      if (ts.isPropertyAssignment(current) && ts.isIdentifier(current.name)) {
        names.add(current.name.text);
      }
      ts.forEachChild(current, walk);
    };
    walk(node);
    return names;
  };

  const enclosingName = (node: ts.Node): string => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) {
        const name = current.name;
        return name !== undefined && ts.isIdentifier(name) ? name.text : "<anonymous>";
      }
      if (ts.isPropertyDeclaration(current) && ts.isIdentifier(current.name)) {
        return current.name.text;
      }
      current = current.parent;
    }
    return "<module>";
  };

  /**
   * The INNERMOST enclosing method/function body, which is the strict reading.
   * Taking the outermost would let a nested helper inherit its caller's guards
   * and satisfy the rule without holding one of its own. Arrow functions are
   * deliberately transparent — `$transaction(async (tx) => …)` is the same
   * lexical scope as the method that opened it, and the guards live there.
   */
  const enclosingBody = (node: ts.Node): ts.Node | null => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) {
        return current.body ?? null;
      }
      current = current.parent;
    }
    return null;
  };

  const guardsIn = (body: ts.Node | null): string[] => {
    if (!body) return [];
    const found: string[] = [];
    const walk = (current: ts.Node) => {
      const call = delegateCall(current);
      if (
        call &&
        (REQUIRED_ANCESTOR_DELEGATES as readonly string[]).includes(call.model) &&
        call.operation.startsWith("find")
      ) {
        const fields = fieldsOf((current as ts.CallExpression).arguments[0]);
        if (REQUIRED_ANCESTOR_FIELDS.every((field) => fields.has(field))) found.push(call.model);
      }
      ts.forEachChild(current, walk);
    };
    walk(body);
    return found;
  };

  const visit = (node: ts.Node) => {
    const call = delegateCall(node);
    if (call && call.model === GUARDED_MODEL && DESTRUCTIVE_OPERATIONS.has(call.operation)) {
      sites.push({
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        enclosing: enclosingName(node),
        guardedBy: guardsIn(enclosingBody(node)),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

describe("no unguarded EnvironmentEntityTool delete can return to the registry", () => {
  const subjectPath = resolve(process.cwd(), "../..", SUBJECT);
  const subjectText = readFileSync(subjectPath, "utf8");

  it("every destructive site resolves BOTH ancestors under organization and project first", () => {
    const sites = destructiveSites(subjectText, SUBJECT);
    // NON-VACUITY. `registerTools` prunes, so the walker must find at least one
    // site; zero would mean the analyzer is broken and the loop below vacuous.
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect(
        [...site.guardedBy].sort(),
        `${SUBJECT}:${site.line} (${site.enclosing}) deletes EnvironmentEntityTool rows without ` +
          `resolving both ancestors under organizationId and projectId in the same function`,
      ).toEqual([...REQUIRED_ANCESTOR_DELEGATES].sort());
    }
  });

  it("THE NEGATIVE CONTROL: the analyzer reports the deleted method's exact shape", () => {
    // The case above compares an AST walk to a rule. If the walk were wrong in
    // the permissive direction it would pass on any file at all, so this asks
    // the same question of `reconcileEntityTools` as it was written and requires
    // the answer to change. Restoring that method turns the case above RED.
    const restored = `
      class Restored {
        private prisma: any;
        async reconcileEntityTools(entityPk: string, environmentId: string, fresh: string[]) {
          const mappings = await this.prisma.environmentEntityTool.findMany({
            where: { entityId: entityPk, environmentId },
          });
          await this.prisma.environmentEntityTool.deleteMany({
            where: { id: { in: mappings.map((m: any) => m.id) } },
          });
          return { removed: mappings.length };
        }
      }
    `;
    const sites = destructiveSites(restored, "restored.ts");
    expect(sites).toHaveLength(1);
    expect(sites[0]!.enclosing).toBe("reconcileEntityTools");
    expect(sites[0]!.guardedBy).toEqual([]);
  });

  it("THE SECOND NEGATIVE CONTROL: reading the ancestors WITHOUT constraining them is not a guard", () => {
    // The rule is not "this function mentions the two delegates". A resolve by
    // primary key alone tells you the row exists, not that the caller's tenant
    // owns it — and a version of the analyzer that stopped requiring
    // `organizationId` and `projectId` would pass on exactly this source. So the
    // permissive analyzer is the thing being refused here.
    const byIdOnly = `
      class Weakened {
        private prisma: any;
        async prune(entityPk: string, environmentId: string) {
          const entity = await this.prisma.entity.findFirst({ where: { id: entityPk } });
          const environment = await this.prisma.environment.findFirst({
            where: { id: environmentId },
          });
          if (!entity || !environment) throw new Error("nope");
          await this.prisma.environmentEntityTool.deleteMany({
            where: { entityId: entityPk, environmentId },
          });
        }
      }
    `;
    const sites = destructiveSites(byIdOnly, "weakened.ts");
    expect(sites).toHaveLength(1);
    expect(sites[0]!.guardedBy).toEqual([]);
  });

  it("the deleted method is not back on the service", () => {
    // Cheap, exact, and it cannot be satisfied by a rename: the property is read
    // off the prototype rather than searched for in text.
    expect(Object.getOwnPropertyNames(ToolRegistryService.prototype)).not.toContain(
      "reconcileEntityTools",
    );
    // Non-vacuity for the assertion above — the prototype really was read.
    expect(Object.getOwnPropertyNames(ToolRegistryService.prototype)).toContain("registerTools");
  });
});
