// What the `observability` suites need on top of the shared container: a fresh
// tenant chain per suite, and nothing else.
//
// NOTHING ELSE, AND THAT IS A FINDING RATHER THAN A CONVENIENCE. Every other
// owner in this directory needs a peer chain seeded through `prisma db execute`
// because its rows point at another context's — `governance`'s five all hang off
// a `Thread` or an `Agent`, `channels`' links off a `Thread`, `conversations`'
// priced steps off a `ModelPrice`. `AdminAudit` has exactly ONE foreign key,
// `AdminAudit_environmentId_fkey`, and its `actorUserId` is a PLAIN NULLABLE
// TEXT COLUMN with no relation at all.
//
// So an audit row can name an operator the tenancy tree has never heard of, and
// the database will hold it. That is deliberate — the column has to survive the
// operator being erased, which is the whole point of the unlink the port asks
// for — but it means nothing structural relates an audit row to a person, and
// `countAdminAuditForActor` is a string match narrowed by a relation walk to the
// organization. `observability-constraints.integration.test.ts` pins it.
//
// THE TENANT CHAIN GOES THROUGH THE PORT. `Organization`, `Project` and
// `Environment` are `tenancy`'s rows and `tenancy`'s canonical store is this same
// directory (ADR M0.3 §15), so a scope is created by calling `saveOrganization`,
// `saveProject` and `saveEnvironment` rather than by writing SQL. A fresh chain
// per case is what keeps a listing that returns everything in an environment
// from seeing another case's rows.

import {
  asIdentifier,
  environmentScope,
  type AdminAuditId,
  type AdminAuditRecord,
  type EnvironmentScope,
  type PrincipalId,
} from "@platos/context-observability/application/ports/index.js";
import type {
  EnvironmentId,
  ProjectId,
  Slug,
} from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier as asTenancyIdentifier } from "@platos/context-tenancy/application/ports/index.js";

import type { TenancyHarness } from "./harness.js";
import { AT, startTenancyHarness } from "./harness.js";
import type { ObservabilityStores } from "./observability-repository.js";

/** One tenant chain, with the ids the suites need to spell a foreign one. */
export interface AuditScope {
  readonly scope: EnvironmentScope;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

export interface ObservabilityHarness {
  readonly base: TenancyHarness;
  readonly stores: ObservabilityStores;
  /** A brand-new organization, project and environment, through the tenancy port. */
  freshScope(): Promise<AuditScope>;
  /**
   * A SECOND environment under an existing project.
   *
   * The sharpest cross-tenant fixture this table has. A sibling environment
   * satisfies BOTH relation clauses of `environmentWhere` — same project, same
   * organization — so it is the only shape that can tell the `environmentId`
   * clause from the two around it. Two tenants cannot: they fail every clause at
   * once.
   */
  siblingEnvironment(parent: AuditScope): Promise<AuditScope>;
  /**
   * A SECOND project, with its own environment, under an existing organization.
   *
   * What tells the ancestry statement's THREE clauses apart on the write path.
   * A foreign tenant fails all three at once, so it proves only that some clause
   * is there; a sibling project fails the `projectId` clause alone, and a scope
   * that keeps the right project and lies about the organization fails the
   * organization clause alone.
   */
  siblingProject(parent: AuditScope): Promise<AuditScope>;
  stop(): Promise<void>;
}

export async function startObservabilityHarness(): Promise<ObservabilityHarness> {
  const base = await startTenancyHarness();
  const stores = base.adapter as unknown as ObservabilityStores;

  const harness: ObservabilityHarness = {
    base,
    stores,

    async freshScope(): Promise<AuditScope> {
      // The WHOLE fresh identifier, not a slice: `Organization.slug` is UNIQUE
      // installation-wide and `freshId` varies only in its LAST group, so a
      // slice of the middle is the same string on every call.
      const organizationId = await base.seedOrganization(`obs-${base.freshId("0021")}`);
      const projectId = await base.seedProject(organizationId, `proj-${base.freshId("0022")}`);
      const environmentId = asTenancyIdentifier<EnvironmentId>(base.freshId("0023"));
      await base.adapter.unitOfWork.run((transaction) =>
        base.adapter.saveEnvironment(
          {
            id: environmentId,
            projectId: projectId as ProjectId,
            slug: asTenancyIdentifier<Slug>("prod"),
            name: "prod",
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
      return {
        scope: environmentScope(
          asIdentifier(organizationId),
          asIdentifier(projectId),
          asIdentifier(environmentId),
        ),
        organizationId,
        projectId,
        environmentId,
      };
    },

    async siblingEnvironment(parent: AuditScope): Promise<AuditScope> {
      const environmentId = asTenancyIdentifier<EnvironmentId>(base.freshId("0024"));
      await base.adapter.unitOfWork.run((transaction) =>
        base.adapter.saveEnvironment(
          {
            id: environmentId,
            projectId: parent.projectId as ProjectId,
            // `@@unique([projectId, slug])` on `Environment`, so a sibling under
            // the same project needs a slug of its own.
            slug: asTenancyIdentifier<Slug>(`staging-${environmentId.slice(-6)}`),
            name: "staging",
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
      return {
        scope: environmentScope(
          asIdentifier(parent.organizationId),
          asIdentifier(parent.projectId),
          asIdentifier(environmentId),
        ),
        organizationId: parent.organizationId,
        projectId: parent.projectId,
        environmentId,
      };
    },

    async siblingProject(parent: AuditScope): Promise<AuditScope> {
      const projectId = await base.seedProject(
        asTenancyIdentifier(parent.organizationId),
        `proj-${base.freshId("0025")}`,
      );
      const environmentId = asTenancyIdentifier<EnvironmentId>(base.freshId("0026"));
      await base.adapter.unitOfWork.run((transaction) =>
        base.adapter.saveEnvironment(
          {
            id: environmentId,
            projectId,
            slug: asTenancyIdentifier<Slug>("prod"),
            name: "prod",
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
      return {
        scope: environmentScope(
          asIdentifier(parent.organizationId),
          asIdentifier(projectId),
          asIdentifier(environmentId),
        ),
        organizationId: parent.organizationId,
        projectId,
        environmentId,
      };
    },

    async stop(): Promise<void> {
      await base.stop();
    },
  };
  return harness;
}

/** The one instant every fixture record is stamped with. */
export const AUDIT_AT = new Date("2026-05-01T09:00:00.000Z");

/**
 * A record the domain would have built, spelled once.
 *
 * It is assembled by hand rather than through `buildAdminAuditRecord` on
 * purpose: the suites need to send values the DOMAIN refuses — a non-uuid id, a
 * blank actor — and a fixture that could only produce valid records could not
 * measure what the DATABASE adds on top of the domain.
 */
export function auditRecord(
  scope: EnvironmentScope,
  adminAuditId: string,
  overrides: Partial<Omit<AdminAuditRecord, "adminAuditId" | "scope">> = {},
): AdminAuditRecord {
  return {
    adminAuditId: asIdentifier<AdminAuditId>(adminAuditId),
    scope,
    actorUserId: asIdentifier<PrincipalId>("operator-1"),
    action: "agent.delete",
    subjectType: "Agent",
    subjectId: "agent-7",
    before: { name: "support bot", isActive: true },
    after: null,
    reason: "retired by the owner",
    source: "ui",
    recordedAt: AUDIT_AT,
    ...overrides,
  };
}
