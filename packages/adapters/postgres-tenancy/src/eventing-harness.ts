// What the `eventing` suites need on top of the shared container: a tenant tree
// deep enough for the ancestry filter to be falsifiable, and a way to plant rows
// this store refuses to write.
//
// ONE TENANT IS TWO PROJECTS AND THREE ENVIRONMENTS, AND EVERY SUITE BUILDS TWO
// OF THEM. That is the minimum rather than a convenience: `scopedWhere` narrows
// on `environmentId` AND on the project AND on the organization above it, and the
// erasure containment widens through the same three, so falsifying each conjunct
// needs a different neighbour:
//
//   `scope`    the environment under test.
//   `sibling`  a SECOND environment of the SAME project. Without it, "the id is
//              right but the environment is another one" cannot be told apart
//              from "no such rule" — every read would return null for the same
//              reason and the environment clause would be unfalsifiable.
//   `crossed`  the SAME environment id read under a DIFFERENT project and
//              organization. This is the one a store narrowing on the leaf
//              column alone would get wrong, and it is why the harness exposes
//              the raw ids as well as the scopes: the case builds the triple
//              itself rather than being handed one.
//   `cousin`   an environment of a SECOND PROJECT in the SAME organization.
//              Without it a PROJECT-level erasure cannot be told apart from an
//              organization-level one: every row an organization reaches would
//              also be a row its only project reaches, and the project clause of
//              the containment join would change no answer anything asked for.
//   `foreign`  a whole second organization, with its own project and
//              environment. Without it the organization conjunct is
//              unfalsifiable and an erasure addressed at an organization cannot
//              be shown to stop at its own.
//
// EVERY FIXTURE ROW GOES THROUGH A PORT, and unlike `governance`'s harness
// nothing has to be seeded as SQL to make the fixture work. `Organization`,
// `Project` and `Environment` are `tenancy`'s rows and `tenancy`'s canonical
// store is this same directory (ADR M0.3 §15), so a scope is built by calling
// `saveOrganization`, `saveProject` and `saveEnvironment`; `NotificationRule` is
// this context's own and is written through the repository under measurement.
//
// `applyRows` EXISTS FOR THE ROWS THE STORE REFUSES TO WRITE, WHICH IS THE
// POINT. A `filters` column with no `eventTypes`, a `delivery` whose `type` is
// outside the union, and a `name` longer than the 120 characters the COLUMN does
// not bound are all rows an OLDER BINARY could have written and this one cannot
// — which is exactly what the readers in `eventing-rows.ts` are for. The only
// way to prove the READ path survives them is to plant them, and the only tool
// that can is the ORM's own CLI, which is runtime and therefore outside the
// sole-writer scanner's scope by construction.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type {
  EnvironmentScope,
  NotificationRuleRepository,
  TransactionScope,
} from "@platos/context-eventing/application/ports/index.js";
import { asIdentifier, environmentScope } from "@platos/context-eventing/application/ports/index.js";
import type {
  EnvironmentId,
  OrganizationId,
  ProjectId,
  Slug,
} from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier as asTenancyIdentifier } from "@platos/context-tenancy/application/ports/index.js";
import { runResult } from "@platos/kernel";
import type { NotResult } from "@platos/kernel";

import type { TenancyHarness } from "./harness.js";
import { AT, startTenancyHarness } from "./harness.js";

const packageRoot = process.cwd();
const databasePackage = resolve(packageRoot, "../../../internal-packages/tenancy-database");
const prismaBinary = resolve(packageRoot, "../../../node_modules/.bin/prisma");

/** One organization, TWO projects, three environments — plus the raw ids. */
export interface EventingTenant {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly siblingEnvironmentId: string;
  readonly cousinProjectId: string;
  readonly cousinEnvironmentId: string;
  /** The environment under test. */
  readonly scope: EnvironmentScope;
  /** A SECOND environment of the SAME project. */
  readonly sibling: EnvironmentScope;
  /** An environment of a SECOND PROJECT in the SAME organization. */
  readonly cousin: EnvironmentScope;
}

export interface EventingHarness {
  readonly base: TenancyHarness;
  readonly repository: NotificationRuleRepository;
  freshTenant(): Promise<EventingTenant>;
  /** Rows this store refuses to write, applied by the ORM's own CLI. */
  applyRows(sql: string): void;
  /** Open one transaction over the adapter's own ambient frame. */
  run<Value>(work: (transaction: TransactionScope) => Promise<NotResult<Value>>): Promise<Value>;
  statements(): readonly string[];
  resetStatements(): void;
  stop(): Promise<void>;
}

/** A scope from three raw ids, so a case can build a CROSSED one deliberately. */
export function scopeOf(
  organizationId: string,
  projectId: string,
  environmentId: string,
): EnvironmentScope {
  return environmentScope(
    asIdentifier(organizationId),
    asIdentifier(projectId),
    asIdentifier(environmentId),
  );
}

export async function startEventingHarness(): Promise<EventingHarness> {
  const base = await startTenancyHarness();
  const repository = base.adapter;

  function applyRows(sql: string): void {
    execFileSync(prismaBinary, ["db", "execute", "--url", base.databaseUrl, "--stdin"], {
      cwd: databasePackage,
      env: { ...process.env, DATABASE_URL: base.databaseUrl },
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  async function seedEnvironment(projectId: ProjectId, slug: string): Promise<EnvironmentId> {
    const environmentId = asTenancyIdentifier<EnvironmentId>(base.freshId("0031"));
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

  const harness: EventingHarness = {
    base,
    repository,
    applyRows,
    statements: () => base.statements(),
    resetStatements: () => base.resetStatements(),

    async run(work) {
      return base.adapter.unitOfWork.run(work);
    },

    async freshTenant(): Promise<EventingTenant> {
      // The WHOLE fresh identifier, not a slice: `Organization.slug` is UNIQUE
      // installation-wide and `freshId` varies only in its LAST group, so a
      // slice of the middle is the same string on every call.
      const organizationId: OrganizationId = await base.seedOrganization(
        `evt-${base.freshId("0011")}`,
      );
      const projectId = await base.seedProject(organizationId, `proj-${base.freshId("0012")}`);
      const cousinProjectId = await base.seedProject(organizationId, `cus-${base.freshId("0013")}`);
      const environmentId = await seedEnvironment(projectId, "prod");
      const siblingEnvironmentId = await seedEnvironment(projectId, "staging");
      const cousinEnvironmentId = await seedEnvironment(cousinProjectId, "prod");
      return {
        organizationId,
        projectId,
        environmentId,
        siblingEnvironmentId,
        cousinProjectId,
        cousinEnvironmentId,
        scope: scopeOf(organizationId, projectId, environmentId),
        sibling: scopeOf(organizationId, projectId, siblingEnvironmentId),
        cousin: scopeOf(organizationId, cousinProjectId, cousinEnvironmentId),
      };
    },

    async stop(): Promise<void> {
      await base.stop();
    },
  };
  return harness;
}
