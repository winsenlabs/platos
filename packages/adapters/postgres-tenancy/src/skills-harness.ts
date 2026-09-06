// What the `skills` suites need on top of the shared container: a tenant tree
// deep enough for the visibility rule to be falsifiable, and a way to plant rows
// this store cannot write.
//
// THE TENANT TREE IS FOUR ENVIRONMENTS AND THAT IS THE MINIMUM, not a
// convenience. `domain/visibility.ts` makes a row visible when its organization
// matches AND (it is official OR it is adopted in THIS project AND bound in THIS
// environment). Falsifying each conjunct needs a different neighbour:
//
//   `prod`     the environment under test.
//   `staging`  a SECOND environment of the SAME project. Without it, "adopted in
//              the project but not bound here" is unreachable and an adapter
//              that checked only the project half would pass every case.
//   `sibling`  an environment of a SECOND project in the same ORGANIZATION.
//              Without it, "official is organization-wide" cannot be told apart
//              from "official is global".
//   `foreign`  a whole second organization. Without it, the organization
//              conjunct is unfalsifiable.
//
// EVERY ROW GOES THROUGH A PORT, and for once nothing has to be seeded as SQL to
// make the fixture work. `Organization`, `Project` and `Environment` are
// `tenancy`'s rows and `tenancy`'s canonical store is this same directory (ADR
// M0.3 §15), so a scope is built by calling `saveOrganization`, `saveProject` and
// `saveEnvironment`; `Skill`, `ProjectSkill` and `EnvironmentSkill` are this
// context's own and are written through the repository under test. That is
// unlike `governance`'s harness, which has to reach for `prisma db execute`
// because three of its five tables hang off a `Thread` and `conversations` has
// no entry in `CANONICAL_STORE_ADAPTERS`.
//
// `applyRows` EXISTS FOR THE ROWS THE STORE REFUSES TO WRITE, WHICH IS THE
// POINT. A `Skill` whose `origin` is outside the closed set, whose `tags` is SQL
// NULL, or whose `manifest` is missing a field are all rows an OLDER BINARY
// could have written and this one cannot — that is exactly what the guards in
// `skills-guards.ts` are for. The only way to prove the READ path survives them
// is to plant them, and the only tool that can is the ORM's own CLI, which is
// runtime and therefore outside the sole-writer scanner's scope by construction.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type {
  CatalogueScope,
  SkillsRepository,
} from "@platos/context-skills/application/ports/index.js";
import { asIdentifier, catalogueScope } from "@platos/context-skills/application/ports/index.js";
import type {
  EnvironmentId,
  OrganizationId,
  ProjectId,
  Slug,
} from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier as asTenancyIdentifier } from "@platos/context-tenancy/application/ports/index.js";
import { runResult } from "@platos/context-skills/application/ports/index.js";
import type { NotResult } from "@platos/context-skills/application/ports/index.js";

import type { TenancyHarness } from "./harness.js";
import { AT, startTenancyHarness } from "./harness.js";

const packageRoot = process.cwd();
const databasePackage = resolve(packageRoot, "../../../internal-packages/tenancy-database");
const prismaBinary = resolve(packageRoot, "../../../node_modules/.bin/prisma");

/** One organization, two projects, and three environments across them. */
export interface SkillsTenant {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly stagingEnvironmentId: string;
  readonly siblingProjectId: string;
  readonly siblingEnvironmentId: string;
  /** `prod` of the first project — where nearly every case is addressed. */
  readonly scope: CatalogueScope;
  /** `staging` of the SAME project. The second-conjunct witness. */
  readonly staging: CatalogueScope;
  /** `prod` of a SECOND project in the same organization. */
  readonly sibling: CatalogueScope;
}

export interface SkillsHarness {
  readonly base: TenancyHarness;
  readonly repository: SkillsRepository;
  freshTenant(): Promise<SkillsTenant>;
  /** Rows this store refuses to write, applied by the ORM's own CLI. */
  applyRows(sql: string): void;
  /** Open one transaction over the adapter's own ambient frame. */
  run<Value>(
    work: (
      transaction: import("@platos/context-skills/application/ports/index.js").TransactionScope,
    ) => Promise<NotResult<Value>>,
  ): Promise<Value>;
  statements(): readonly string[];
  resetStatements(): void;
  stop(): Promise<void>;
}

export async function startSkillsHarness(): Promise<SkillsHarness> {
  const base = await startTenancyHarness();
  const repository = base.adapter.skills;

  function applyRows(sql: string): void {
    execFileSync(prismaBinary, ["db", "execute", "--url", base.databaseUrl, "--stdin"], {
      cwd: databasePackage,
      env: { ...process.env, DATABASE_URL: base.databaseUrl },
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  async function seedEnvironment(projectId: ProjectId, slug: string): Promise<EnvironmentId> {
    const environmentId = asTenancyIdentifier<EnvironmentId>(base.freshId("0021"));
    await base.adapter.unitOfWork.run((transaction) =>
      base.adapter.saveEnvironment(
        {
          id: environmentId,
          projectId,
          slug: asTenancyIdentifier<Slug>(slug),
          name: slug,
          archivedAt: null,
          accessKeyRevocationVersion: 0,
          memoryFeedbackBackfillCursor: null,
          memoryFeedbackBackfillCompletedAt: null,
          createdAt: AT,
          updatedAt: AT,
        },
        transaction,
      ),
    );
    return environmentId;
  }

  function scopeOf(
    organizationId: OrganizationId,
    projectId: ProjectId,
    environmentId: EnvironmentId,
  ): CatalogueScope {
    return catalogueScope({
      level: "environment",
      organizationId: asIdentifier(organizationId),
      projectId: asIdentifier(projectId),
      environmentId: asIdentifier(environmentId),
    });
  }

  const harness: SkillsHarness = {
    base,
    repository,
    applyRows,
    statements: () => base.statements(),
    resetStatements: () => base.resetStatements(),

    async run(work) {
      return base.adapter.unitOfWork.run(work);
    },

    async freshTenant(): Promise<SkillsTenant> {
      // The WHOLE fresh identifier, not a slice: `Organization.slug` is UNIQUE
      // installation-wide and `freshId` varies only in its LAST group, so a
      // slice of the middle is the same string on every call.
      const organizationId = await base.seedOrganization(`skl-${base.freshId("0011")}`);
      const projectId = await base.seedProject(organizationId, `proj-${base.freshId("0012")}`);
      const siblingProjectId = await base.seedProject(organizationId, `sib-${base.freshId("0013")}`);
      const environmentId = await seedEnvironment(projectId, "prod");
      const stagingEnvironmentId = await seedEnvironment(projectId, "staging");
      const siblingEnvironmentId = await seedEnvironment(siblingProjectId, "prod");
      return {
        organizationId,
        projectId,
        environmentId,
        stagingEnvironmentId,
        siblingProjectId,
        siblingEnvironmentId,
        scope: scopeOf(organizationId, projectId, environmentId),
        staging: scopeOf(organizationId, projectId, stagingEnvironmentId),
        sibling: scopeOf(organizationId, siblingProjectId, siblingEnvironmentId),
      };
    },

    async stop(): Promise<void> {
      await base.stop();
    },
  };
  return harness;
}
