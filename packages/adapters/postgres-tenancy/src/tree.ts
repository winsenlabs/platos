// The organization -> project -> environment tree, over PostgreSQL.
//
// TWO PROPERTIES ARE LOAD-BEARING HERE AND ARE TESTED AS SUCH.
//
// ONE READ FOR AN ANCESTRY. `loadEnvironmentAncestry` is a single SELECT with
// two joins, not three round trips. The port's own comment says the oracle
// re-derives the whole chain from the leaf, so this is the read every
// authorization decision in the product sits behind; issuing it three times
// would put two extra round trips on the hot path of every request. The
// integration suite counts the statements the client actually sends and pins the
// number, so a later change that reaches for a lazy relation instead is a
// failing test rather than a slow afternoon.
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
