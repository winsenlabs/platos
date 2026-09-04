// The organization -> project -> environment tree, over PostgreSQL.
//
// TWO PROPERTIES ARE LOAD-BEARING HERE AND ARE TESTED AS SUCH.
//
// AN ANCESTRY COSTS A CONSTANT NUMBER OF STATEMENTS. `loadEnvironmentAncestry`
// asks for the environment and its two ancestors in ONE call, with a nested
// `include`. MEASURED, that is three statements and not one: this client's
// default relation strategy issues a statement per level rather than a join, and
// the integration suite reports three. Three is the honest number and it is
// pinned as three, because the property that matters is that it does not GROW —
// the port's comment says the oracle re-derives the whole chain from the leaf,
// so this read sits behind every authorization decision in the product, and a
// version that fetched siblings and then filtered would cost a statement per
// row. The suite proves the count is identical for a one-project tenant and a
// twenty-project one, which is what "no N+1" means; pinning "1" would have
// been a claim about a join that is not being issued.
//
// A LIST IS ONE STATEMENT, whatever its length. `listProjects` and
// `listEnvironments` hydrate no relation, so they cost one statement for
// twenty-five rows exactly as they do for one, and the suite pins that too.
//
// EVERY LOOKUP USES ITS OWN COMPOUND INDEX. `findProjectBySlug` filters on
// `@@unique([organizationId, slug])`, not on slug with an organization check
// afterwards. The difference is not performance: a lookup that finds the row
// first and compares tenants second has already read another tenant's row, and
// the comparison is one edit away from being deleted.

import type {
  EnvironmentAncestry,
  EnvironmentId,
  EnvironmentRecord,
  OrganizationId,
  OrganizationRecord,
  ProjectId,
  ProjectRecord,
  Slug,
  TransactionScope,
} from "@platos/context-tenancy/application/ports/index.js";

import { toEnvironment, toOrganization, toProject } from "./mapping.js";
import type { TenancyTransactions } from "./transaction.js";

/** Deterministic order for every list this adapter returns. */
export const LIST_ORDER = [{ createdAt: "asc" }, { id: "asc" }] as const;

export function createTreeRepository(transactions: TenancyTransactions) {
  return {
    async loadEnvironmentAncestry(
      environmentId: EnvironmentId,
    ): Promise<EnvironmentAncestry | null> {
      const row = await transactions.reader().environment.findUnique({
        where: { id: environmentId },
        include: { project: { include: { organization: true } } },
      });
      if (row === null) return null;
      return {
        organization: toOrganization(row.project.organization),
        project: toProject(row.project),
        environment: toEnvironment(row),
      };
    },

    async loadOrganization(organizationId: OrganizationId): Promise<OrganizationRecord | null> {
      const row = await transactions
        .reader()
        .organization.findUnique({ where: { id: organizationId } });
      return row === null ? null : toOrganization(row);
    },

    async loadProject(projectId: ProjectId): Promise<ProjectRecord | null> {
      const row = await transactions.reader().project.findUnique({ where: { id: projectId } });
      return row === null ? null : toProject(row);
    },

    async loadEnvironment(environmentId: EnvironmentId): Promise<EnvironmentRecord | null> {
      const row = await transactions
        .reader()
        .environment.findUnique({ where: { id: environmentId } });
      return row === null ? null : toEnvironment(row);
    },

    async findOrganizationBySlug(slug: Slug): Promise<OrganizationRecord | null> {
      const row = await transactions.reader().organization.findUnique({ where: { slug } });
      return row === null ? null : toOrganization(row);
    },

    async findProjectBySlug(
      organizationId: OrganizationId,
      slug: Slug,
    ): Promise<ProjectRecord | null> {
      const row = await transactions.reader().project.findUnique({
        where: { organizationId_slug: { organizationId, slug } },
      });
      return row === null ? null : toProject(row);
    },

    async findEnvironmentBySlug(
      projectId: ProjectId,
      slug: Slug,
    ): Promise<EnvironmentRecord | null> {
      const row = await transactions.reader().environment.findUnique({
        where: { projectId_slug: { projectId, slug } },
      });
      return row === null ? null : toEnvironment(row);
    },

    async listProjects(organizationId: OrganizationId): Promise<readonly ProjectRecord[]> {
      const rows = await transactions
        .reader()
        .project.findMany({ where: { organizationId }, orderBy: [...LIST_ORDER] });
      return rows.map(toProject);
    },

    async listEnvironments(projectId: ProjectId): Promise<readonly EnvironmentRecord[]> {
      const rows = await transactions
        .reader()
        .environment.findMany({ where: { projectId }, orderBy: [...LIST_ORDER] });
      return rows.map(toEnvironment);
    },

    async saveOrganization(
      organization: OrganizationRecord,
      transaction: TransactionScope,
    ): Promise<void> {
      const data = {
        slug: organization.slug,
        name: organization.name,
        archivedAt: organization.archivedAt,
        createdAt: organization.createdAt,
        updatedAt: organization.updatedAt,
      };
      await transactions.writer(transaction).organization.upsert({
        where: { id: organization.id },
        create: { id: organization.id, ...data },
        update: data,
      });
    },

    async saveProject(project: ProjectRecord, transaction: TransactionScope): Promise<void> {
      const data = {
        organizationId: project.organizationId,
        slug: project.slug,
        name: project.name,
        archivedAt: project.archivedAt,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };
      await transactions.writer(transaction).project.upsert({
        where: { id: project.id },
        create: { id: project.id, ...data },
        update: data,
      });
    },

    async saveEnvironment(
      environment: EnvironmentRecord,
      transaction: TransactionScope,
    ): Promise<void> {
      const data = {
        projectId: environment.projectId,
        slug: environment.slug,
        name: environment.name,
        archivedAt: environment.archivedAt,
        accessKeyRevocationVersion: environment.accessKeyRevocationVersion,
        memoryFeedbackBackfillCursor: environment.memoryFeedbackBackfillCursor,
        memoryFeedbackBackfillCompletedAt: environment.memoryFeedbackBackfillCompletedAt,
        createdAt: environment.createdAt,
        updatedAt: environment.updatedAt,
      };
      await transactions.writer(transaction).environment.upsert({
        where: { id: environment.id },
        create: { id: environment.id, ...data },
        update: data,
      });
    },
  };
}
