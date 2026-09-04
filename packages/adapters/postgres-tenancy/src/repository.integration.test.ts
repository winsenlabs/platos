// The PostgreSQL `TenancyRepository`, against a REAL PostgreSQL.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE UNIT SUITES. WIN-258's acceptance
// asks for "repository contracts with real PostgreSQL integration tests", and an
// in-memory double cannot supply that evidence: four defects shipped in this
// repository this week because a double did not behave like the schema — a unit
// of work with nothing to roll back, a double that did not cascade a foreign
// key, stores that enforced the constraint the guard was meant to, and an outbox
// that survived a rolled-back transaction. Everything below that COULD pass
// against a fake is asserted against both; everything that could not is asserted
// only here and is grouped under a heading that says so.
//
// Excluded from `vitest run` by vitest.config.ts and run by
// `pnpm test:postgres-tenancy:integration` in its own CI job, because the
// typecheck job has no Docker daemon.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createInMemoryTenancyRepository,
  createTenancyStore,
  createUnitOfWork,
} from "@platos/context-tenancy/application/index.js";
import type {
  OrganizationId,
  OrganizationMembershipId,
  TenancyRepository,
} from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier, OrganizationRole } from "@platos/context-tenancy/application/ports/index.js";

import type { ConformanceIds } from "./conformance.js";
import { runTenancyConformance } from "./conformance.js";
import type { TenancyHarness } from "./harness.js";
import { AT, MEMBER_USER, OPERATOR_SESSION, OWNER_USER, SECOND_OWNER_USER, startTenancyHarness } from "./harness.js";

const CONFORMANCE_IDS: ConformanceIds = {
  organizationId: "aaaaaaaa-0000-4000-8000-000000000001",
  projectId: "aaaaaaaa-0000-4000-8000-000000000002",
  environmentId: "aaaaaaaa-0000-4000-8000-000000000003",
  ownerUserId: OWNER_USER,
  secondOwnerUserId: SECOND_OWNER_USER,
  memberUserId: MEMBER_USER,
  invitationId: "aaaaaaaa-0000-4000-8000-000000000004",
  entityId: "aaaaaaaa-0000-4000-8000-000000000005",
  environmentSessionId: "aaaaaaaa-0000-4000-8000-000000000006",
  operatorSessionId: OPERATOR_SESSION,
};

let harness: TenancyHarness;

beforeAll(async () => {
  harness = await startTenancyHarness();
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

describe("the shared conformance scenario", () => {
  test("the postgres adapter and the in-memory fake answer it identically", async () => {
    const store = createTenancyStore();
    const fake: TenancyRepository = createInMemoryTenancyRepository(store);
    const fakeObserved = await runTenancyConformance(fake, createUnitOfWork(store), CONFORMANCE_IDS);
    const realObserved = await runTenancyConformance(
      harness.adapter,
      harness.adapter.unitOfWork,
      CONFORMANCE_IDS,
    );
    expect(realObserved).toEqual(fakeObserved);
    // Non-vacuity: the scenario has to have observed something, and the three
    // values the rest of this issue turns on are pinned by value.
    expect(Object.keys(realObserved).length).toBeGreaterThan(20);
    expect(realObserved.firstConsume).toBe(1);
    expect(realObserved.secondConsume).toBe(0);
    expect(realObserved.activeOwners).toBe(1);
  });
});

describe("tenant isolation is in the key, not in a check afterwards", () => {
  test("findOrganizationMembershipById refuses to answer across organizations", async () => {
    const home = await harness.seedOrganization("isolation-home");
    const other = await harness.seedOrganization("isolation-other");
    const membership = await harness.adapter.unitOfWork.run((transaction) =>
      harness.adapter.upsertOrganizationMembership(
        {
          organizationId: home,
          userId: asIdentifier(OWNER_USER),
          role: OrganizationRole.OWNER,
          at: AT,
        },
        transaction,
      ),
    );
    const membershipId = asIdentifier<OrganizationMembershipId>(membership.id);
    expect(await harness.adapter.findOrganizationMembershipById(home, membershipId)).not.toBeNull();
    expect(await harness.adapter.findOrganizationMembershipById(other, membershipId)).toBeNull();
  });

  test("findProjectBySlug refuses to answer across organizations", async () => {
    const home = await harness.seedOrganization("project-isolation-home");
    const other = await harness.seedOrganization("project-isolation-other");
    await harness.seedProject(home, "shared-slug");
    await harness.seedProject(other, "shared-slug");
    expect((await harness.adapter.findProjectBySlug(home, asIdentifier("shared-slug")))?.organizationId).toBe(home);
    expect((await harness.adapter.findProjectBySlug(other, asIdentifier("shared-slug")))?.organizationId).toBe(other);
  });

  test("findEntityByExternalId refuses to answer across projects", async () => {
    const organizationId = await harness.seedOrganization("entity-isolation");
    const home = await harness.seedProject(organizationId, "entity-home");
    const other = await harness.seedProject(organizationId, "entity-other");
    await harness.adapter.unitOfWork.run((transaction) =>
      harness.adapter.saveEntity(
        {
          id: asIdentifier(harness.freshId("0005")),
          projectId: home,
          externalId: "shared-external",
          displayName: "Home entity",
          connectionStatus: "CONNECTED",
          connectionKind: "MCP",
          mcpUrls: [],
          allowedOrigins: [],
          capabilities: [],
          lastConnectedAt: null,
          createdAt: AT,
          updatedAt: AT,
        },
        transaction,
      ),
    );
    expect((await harness.adapter.findEntityByExternalId(home, "shared-external"))?.displayName).toBe("Home entity");
    expect(await harness.adapter.findEntityByExternalId(other, "shared-external")).toBeNull();
  });
});

describe("integrity the in-memory double does NOT have", () => {
  test("deleting an organization cascades to its memberships, projects and environments", async () => {
    const organizationId = await harness.seedOrganization("cascade-org");
    const projectId = await harness.seedProject(organizationId, "cascade-project");
    const environmentId = asIdentifier(harness.freshId("0003"));
    await harness.adapter.unitOfWork.run(async (transaction) => {
      await harness.adapter.saveEnvironment(
        {
          id: environmentId,
          projectId,
          slug: asIdentifier("cascade-env"),
          name: "Cascade",
          archivedAt: null,
          accessKeyRevocationVersion: 0,
          memoryFeedbackBackfillCursor: null,
          memoryFeedbackBackfillCompletedAt: null,
          createdAt: AT,
          updatedAt: AT,
        },
        transaction,
      );
      await harness.adapter.upsertOrganizationMembership(
        { organizationId, userId: asIdentifier(MEMBER_USER), role: OrganizationRole.MEMBER, at: AT },
        transaction,
      );
    });
    expect(await harness.adapter.loadEnvironmentAncestry(environmentId)).not.toBeNull();

    await harness.client.organization.delete({ where: { id: organizationId } });

    expect(await harness.adapter.loadOrganization(organizationId)).toBeNull();
    expect(await harness.adapter.loadProject(projectId)).toBeNull();
    expect(await harness.adapter.loadEnvironment(environmentId)).toBeNull();
    expect(
      await harness.adapter.findOrganizationMembershipByUser(organizationId, asIdentifier(MEMBER_USER)),
    ).toBeNull();
  });

  test("a ProjectMembership whose organization disagrees with its project is refused", async () => {
    const home = await harness.seedOrganization("integrity-home");
    const other = await harness.seedOrganization("integrity-other");
    const projectId = await harness.seedProject(home, "integrity-project");
    const membership = await harness.adapter.unitOfWork.run((transaction) =>
      harness.adapter.upsertOrganizationMembership(
        {
          organizationId: home,
          userId: asIdentifier(SECOND_OWNER_USER),
          role: OrganizationRole.ADMIN,
          at: AT,
        },
        transaction,
      ),
    );
    await expect(
      harness.adapter.unitOfWork.run((transaction) =>
        harness.adapter.saveProjectMembership(
          {
            id: asIdentifier(harness.freshId("0007")),
            projectId,
            organizationMembershipId: asIdentifier(membership.id),
            // The lie: this row claims a different tenant than its project has.
            organizationId: other,
            role: "EDITOR",
            createdAt: AT,
            updatedAt: AT,
          },
          transaction,
        ),
      ),
    ).rejects.toBeDefined();
  });

  test("the unique index on an organization slug refuses a second row", async () => {
    await harness.seedOrganization("unique-slug-holder");
    await expect(harness.seedOrganization("unique-slug-holder")).rejects.toBeDefined();
  });

  test("the unique index on (organizationId, slug) refuses a second project", async () => {
    const organizationId = await harness.seedOrganization("unique-project-org");
    await harness.seedProject(organizationId, "unique-project");
    await expect(harness.seedProject(organizationId, "unique-project")).rejects.toBeDefined();
  });
});

describe("read semantics", () => {
  test("loadEnvironmentAncestry issues exactly ONE statement", async () => {
    const organizationId = await harness.seedOrganization("ancestry-org");
    const projectId = await harness.seedProject(organizationId, "ancestry-project");
    const environmentId = asIdentifier(harness.freshId("0003"));
    await harness.adapter.unitOfWork.run((transaction) =>
      harness.adapter.saveEnvironment(
        {
          id: environmentId,
          projectId,
          slug: asIdentifier("ancestry-env"),
          name: "Ancestry",
          archivedAt: null,
          accessKeyRevocationVersion: 3,
          memoryFeedbackBackfillCursor: null,
          memoryFeedbackBackfillCompletedAt: null,
          createdAt: AT,
          updatedAt: AT,
        },
        transaction,
      ),
    );
    harness.resetStatements();
    const ancestry = await harness.adapter.loadEnvironmentAncestry(environmentId);
    expect(ancestry?.organization.id).toBe(organizationId);
    expect(ancestry?.environment.accessKeyRevocationVersion).toBe(3);
    expect(harness.statements().length).toBe(1);
  });

  test("countActiveOwners counts under the same filter as the rows it describes", async () => {
    const organizationId = await harness.seedOrganization("owner-count-org");
    await harness.adapter.unitOfWork.run(async (transaction) => {
      await harness.adapter.upsertOrganizationMembership(
        { organizationId, userId: asIdentifier(OWNER_USER), role: OrganizationRole.OWNER, at: AT },
        transaction,
      );
      await harness.adapter.upsertOrganizationMembership(
        { organizationId, userId: asIdentifier(SECOND_OWNER_USER), role: OrganizationRole.MEMBER, at: AT },
        transaction,
      );
      const removedOwner = await harness.adapter.upsertOrganizationMembership(
        { organizationId, userId: asIdentifier(MEMBER_USER), role: OrganizationRole.OWNER, at: AT },
        transaction,
      );
      await harness.adapter.saveOrganizationMembership(
        { ...removedOwner, deactivatedAt: AT, updatedAt: AT },
        transaction,
      );
    });
    expect(await harness.adapter.countActiveOwners(organizationId)).toBe(1);
  });

  test("listOrganizationMembershipsForUser includes deactivated rows, as the port says", async () => {
    const organizationId = await harness.seedOrganization("deactivated-visible");
    await harness.adapter.unitOfWork.run(async (transaction) => {
      const membership = await harness.adapter.upsertOrganizationMembership(
        { organizationId, userId: asIdentifier(MEMBER_USER), role: OrganizationRole.MEMBER, at: AT },
        transaction,
      );
      await harness.adapter.saveOrganizationMembership(
        { ...membership, deactivatedAt: AT, updatedAt: AT },
        transaction,
      );
    });
    const rows = await harness.adapter.listOrganizationMembershipsForUser(asIdentifier(MEMBER_USER));
    expect(rows.some((row) => row.organizationId === organizationId && row.deactivatedAt !== null)).toBe(true);
  });
});

describe("expand/contract during a rollout", () => {
  test("a row written WITHOUT the columns this binary added still reads back", async () => {
    const organizationId: OrganizationId = await harness.seedOrganization("expand-contract-org");
    const projectId = await harness.seedProject(organizationId, "expand-contract-project");
    const environmentId = harness.freshId("0003");
    // The older binary's write: it names none of `accessKeyRevocationVersion`,
    // `memoryFeedbackBackfillCursor` or `memoryFeedbackBackfillCompletedAt`,
    // because it has never heard of them. The schema's defaults supply them, and
    // this binary reads the row back without noticing.
    await harness.client.environment.create({
      data: {
        id: environmentId,
        projectId,
        slug: "old-binary",
        name: "Written by the old binary",
        createdAt: AT,
        updatedAt: AT,
      },
    });
    const environment = await harness.adapter.loadEnvironment(asIdentifier(environmentId));
    expect(environment?.accessKeyRevocationVersion).toBe(0);
    expect(environment?.memoryFeedbackBackfillCursor).toBeNull();
    expect(environment?.memoryFeedbackBackfillCompletedAt).toBeNull();
    expect(await harness.adapter.loadEnvironmentAncestry(asIdentifier(environmentId))).not.toBeNull();
  });
});
