import { describe, expect, it } from "vitest";

import { asIdentifier, type IdGenerator, type Ulid, type Uuid } from "@platos/kernel";

import {
  OrganizationRole,
  ProjectRole,
  anOrganization,
  anOrganizationMembership,
  organizationId,
  userId,
} from "../domain/index.js";
import { createCreateProject } from "./create-project.js";
import type { TenancyRepository } from "./ports/index.js";
import { UniqueViolation } from "./testing/in-memory-repository.js";
import { createTenancyFixture } from "./testing/tenant-fixture.js";

const MEMBER = userId("mel");
const OUTSIDER = userId("otto");

/**
 * One organization with one plain MEMBER in it.
 *
 * MEMBER, not ADMIN, on purpose: the oracle's gate is "an active membership
 * whose organization is unarchived" and nothing more, so the ordinary case this
 * suite is built on is the weakest role that is allowed to create a project. A
 * use case that quietly required an admin would fail every case below.
 */
function scenario(
  options: {
    readonly archivedAt?: Date | null;
    readonly deactivatedAt?: Date | null;
  } = {},
) {
  const fixture = createTenancyFixture();
  const organization = anOrganization("acme", { archivedAt: options.archivedAt ?? null });
  fixture.store.organizations.push(organization);
  const membership = anOrganizationMembership("m-mel", organization.id, MEMBER, {
    role: OrganizationRole.MEMBER,
    deactivatedAt: options.deactivatedAt ?? null,
  });
  fixture.store.organizationMemberships.push(membership);
  return {
    fixture,
    organization,
    membership,
    create: createCreateProject(fixture.dependencies),
  };
}

/** The same scenario with one repository method replaced by a thrower. */
function scenarioFailingOn(method: keyof TenancyRepository, failure: Error) {
  const built = scenario();
  // A computed key widens the literal, so the spread is asserted back to the
  // port; `keyof TenancyRepository` still checks the name.
  const broken = {
    ...built.fixture.dependencies.repository,
    [method]: async () => {
      throw failure;
    },
  } as TenancyRepository;
  return {
    ...built,
    create: createCreateProject({ ...built.fixture.dependencies, repository: broken }),
  };
}

/**
 * A scenario whose id generator mints the SAME project id every call, so a real
 * index violation can land on the SECOND write instead of the first.
 */
function scenarioWithOneProjectId(fixedId: string) {
  const built = scenario();
  let call = 0;
  const ids: IdGenerator = {
    uuid: () => {
      const value = call % 3 === 0 ? fixedId : `row-${call}`;
      call += 1;
      return asIdentifier<Uuid>(value);
    },
    ulid: () => asIdentifier<Ulid>(`ulid-${call}`),
  };
  return { ...built, create: createCreateProject({ ...built.fixture.dependencies, ids }) };
}

function command(organization = organizationId("acme")) {
  return {
    organizationId: organization,
    actorUserId: MEMBER,
    name: "Checkout",
    slug: "checkout",
    environmentName: "Production",
    environmentSlug: "production",
  } as const;
}

describe("createProject", () => {
  it("writes the project, its first environment and an ADMIN membership together", async () => {
    const { fixture, organization, membership, create } = scenario();
    const created = await create(command());

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.project.organizationId).toBe(organization.id);
    expect(created.value.project.slug).toBe("checkout");
    expect(created.value.environment.projectId).toBe(created.value.project.id);
    expect(created.value.environment.slug).toBe("production");
    expect(created.value.environment.accessKeyRevocationVersion).toBe(0);
    expect(created.value.membership.role).toBe(ProjectRole.ADMIN);
    expect(created.value.membership.organizationMembershipId).toBe(membership.id);

    // All three rows are in the store, not only in the returned value.
    expect(fixture.store.projects).toHaveLength(1);
    expect(fixture.store.environments).toHaveLength(1);
    expect(fixture.store.projectMemberships).toHaveLength(1);
  });

  it("takes the tenant from the LOADED organization, never from the command", async () => {
    // The first version of this case asserted
    // `membership.organizationId === organization.id` against the ordinary
    // fixture, and a mutation replacing `project.organizationId` with
    // `command.organizationId` left it GREEN — under a faithful repository the
    // two are the same value, so it asserted a tautology.
    //
    // The two are separated here by a store that resolves the requested id to a
    // DIFFERENT canonical row, which is what an alias, a rename or a slug-keyed
    // lookup does. Everything the use case builds must hang off the row it
    // LOADED; the moment any of it hangs off the id it was HANDED, the two
    // composite foreign keys disagree and `checkProjectMembershipIntegrity`
    // refuses.
    const fixture = createTenancyFixture();
    const canonical = anOrganization("acme-canonical");
    fixture.store.organizations.push(canonical);
    fixture.store.organizationMemberships.push(
      anOrganizationMembership("m-mel", canonical.id, MEMBER, { role: OrganizationRole.MEMBER }),
    );
    const aliasing = {
      ...fixture.dependencies.repository,
      loadOrganization: async () => canonical,
    } as TenancyRepository;
    const create = createCreateProject({ ...fixture.dependencies, repository: aliasing });

    const created = await create(command(organizationId("acme-alias")));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.project.organizationId).toBe(canonical.id);
    expect(created.value.membership.organizationId).toBe(canonical.id);
    expect(created.value.membership.projectId).toBe(created.value.project.id);
  });

  it("REFUSES when the membership's tenant disagrees with the project's", async () => {
    // The application restatement of the two composite foreign keys. In
    // Postgres this row cannot be inserted at all; in memory there is no
    // foreign key, so `checkProjectMembershipIntegrity` is the only thing
    // between a confused store and a cross-tenant grant.
    const fixture = createTenancyFixture();
    const acme = anOrganization("acme");
    fixture.store.organizations.push(acme);
    const foreign = {
      ...fixture.dependencies.repository,
      findOrganizationMembershipByUser: async () =>
        anOrganizationMembership("m-rival", organizationId("rival"), MEMBER, {
          role: OrganizationRole.MEMBER,
        }),
    } as TenancyRepository;
    const create = createCreateProject({ ...fixture.dependencies, repository: foreign });

    const refusal = await create(command(acme.id));
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("TENANCY_CROSS_TENANT_MEMBERSHIP");
    expect(fixture.store.projects).toEqual([]);
    expect(fixture.unitOfWork.transactionCount()).toBe(0);
  });

  it("commits all three rows in ONE transaction", async () => {
    const { fixture, create } = scenario();
    await create(command());
    expect(fixture.unitOfWork.transactionCount()).toBe(1);
    expect(fixture.unitOfWork.rollbackCount()).toBe(0);
  });

  // --- the guards ----------------------------------------------------------

  it("REFUSES a blank project name and a blank environment name, naming the field", async () => {
    const { fixture, create } = scenario();
    const project = await create({ ...command(), name: "  " });
    expect(project.ok).toBe(false);
    if (project.ok) return;
    expect(project.error.code).toBe("TENANCY_INVALID_NAME");
    expect(project.error.fields[0]?.field).toBe("name");

    const environment = await create({ ...command(), environmentName: "  " });
    expect(environment.ok).toBe(false);
    if (environment.ok) return;
    expect(environment.error.code).toBe("TENANCY_INVALID_NAME");
    // One command carries two names; a caller told only "name" cannot fix the
    // right one.
    expect(environment.error.fields[0]?.field).toBe("environmentName");
    expect(fixture.unitOfWork.transactionCount()).toBe(0);
  });

  it("REFUSES a bad project slug and a bad environment slug, naming the field", async () => {
    const { fixture, create } = scenario();
    const project = await create({ ...command(), slug: "Checkout" });
    expect(project.ok).toBe(false);
    if (project.ok) return;
    expect(project.error.fields[0]?.field).toBe("slug");

    const environment = await create({ ...command(), environmentSlug: "Production" });
    expect(environment.ok).toBe(false);
    if (environment.ok) return;
    expect(environment.error.fields[0]?.field).toBe("environmentSlug");
    expect(fixture.store.projects).toEqual([]);
    expect(fixture.unitOfWork.transactionCount()).toBe(0);
  });

  it("REFUSES an organization that does not exist", async () => {
    const { fixture, create } = scenario();
    const refusal = await create(command(organizationId("no-such-organization")));
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("TENANCY_PROJECT_CREATE_FORBIDDEN");
    expect(refusal.error.details).toEqual({ gate: "no-such-organization" });
    expect(fixture.store.projects).toEqual([]);
  });

  it("REFUSES an ARCHIVED organization, and answers exactly as it does for a missing one", async () => {
    // The oracle folds "no such organization" and "archived" into one query and
    // one 403, so a caller cannot learn which. Same code, same message; only
    // `details.gate`, which is log-only, differs.
    const { fixture, create } = scenario({ archivedAt: new Date("2026-02-01T00:00:00.000Z") });
    const archived = await create(command());
    const missing = await create(command(organizationId("no-such-organization")));
    expect(archived.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (archived.ok || missing.ok) return;
    expect(archived.error.code).toBe(missing.error.code);
    expect(archived.error.message).toBe(missing.error.message);
    expect(archived.error.details).toEqual({ gate: "organization-archived" });
    expect(fixture.store.projects).toEqual([]);
  });

  it("REFUSES A NON-MEMBER, indistinguishably from the two above", async () => {
    const { fixture, create } = scenario();
    const refusal = await create({ ...command(), actorUserId: OUTSIDER });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("TENANCY_PROJECT_CREATE_FORBIDDEN");
    expect(refusal.error.details).toEqual({ gate: "not-a-member" });
    expect(fixture.store.projects).toEqual([]);
    expect(fixture.store.projectMemberships).toEqual([]);
  });

  it("REFUSES A DEACTIVATED MEMBER whose row is still there", async () => {
    // The row exists and matches, so a gate that only asked "is there a
    // membership?" would let a removed member create projects forever.
    const { fixture, create } = scenario({ deactivatedAt: new Date("2026-01-15T00:00:00.000Z") });
    const refusal = await create(command());
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.details).toEqual({ gate: "membership-deactivated" });
    expect(fixture.store.projects).toEqual([]);
  });

  it("REFUSES a project slug already used in the same organization", async () => {
    const { fixture, create } = scenario();
    expect((await create(command())).ok).toBe(true);
    const refusal = await create({ ...command(), name: "Checkout Two" });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("TENANCY_SLUG_TAKEN");
    expect(refusal.error.details).toEqual({ kind: "project" });
    expect(fixture.store.projects).toHaveLength(1);
    expect(fixture.store.environments).toHaveLength(1);
    expect(fixture.store.projectMemberships).toHaveLength(1);
  });

  it("ALLOWS the same project slug in a DIFFERENT organization", async () => {
    // `@@unique([organizationId, slug])`, not a global unique. A slug check that
    // ignored the organization would make every slug in the product scarce.
    const { fixture, create } = scenario();
    expect((await create(command())).ok).toBe(true);

    const other = anOrganization("globex");
    fixture.store.organizations.push(other);
    fixture.store.organizationMemberships.push(
      anOrganizationMembership("m-mel-globex", other.id, MEMBER, {
        role: OrganizationRole.MEMBER,
      }),
    );
    const second = await create(command(other.id));
    expect(second.ok).toBe(true);
    expect(fixture.store.projects).toHaveLength(2);
  });

  // --- atomicity, by failure injection -------------------------------------

  it("COMMITS NEITHER THE PROJECT NOR THE ENVIRONMENT when the membership write fails", async () => {
    // The third of three writes rejects. Without a rollback the product would
    // hold a project whose creator has no role on it — and, for a plain MEMBER,
    // gate 3 of `decideEnvironmentAccess` then denies them their own project
    // forever.
    const { fixture, create } = scenarioFailingOn(
      "saveProjectMembership",
      new Error("membership insert failed"),
    );
    await expect(create(command())).rejects.toThrow("membership insert failed");
    expect(fixture.store.projects).toEqual([]);
    expect(fixture.store.environments).toEqual([]);
    expect(fixture.store.projectMemberships).toEqual([]);
    expect(fixture.unitOfWork.rollbackCount()).toBe(1);
  });

  it("COMMITS NO PROJECT when the environment write fails", async () => {
    // A project with no environment is unreachable: every route below a project
    // is keyed by an environment slug.
    const { fixture, create } = scenarioFailingOn(
      "saveEnvironment",
      new Error("environment insert failed"),
    );
    await expect(create(command())).rejects.toThrow("environment insert failed");
    expect(fixture.store.projects).toEqual([]);
    expect(fixture.store.environments).toEqual([]);
    expect(fixture.unitOfWork.rollbackCount()).toBe(1);
  });

  it("ROLLS BACK A REAL INDEX VIOLATION, with no fault injected at all", async () => {
    // No misbehaving double. Both calls mint the same project id, so the second
    // call writes the project, then hits
    // `Environment_projectId_slug_key` on the write after it. The project row
    // written moments earlier has to disappear with it.
    const { fixture, create } = scenarioWithOneProjectId("project-fixed");
    const first = await create(command());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Clearing the projects lets the slug pre-check pass, so the call reaches
    // the writes; the environment from the first call stays.
    fixture.store.projects.length = 0;
    await expect(create({ ...command(), slug: "checkout-two" })).rejects.toBeInstanceOf(
      UniqueViolation,
    );

    expect(fixture.store.projects).toEqual([]);
    expect(fixture.store.environments).toHaveLength(1);
    expect(fixture.store.environments[0]?.id).toBe(first.value.environment.id);
    expect(fixture.unitOfWork.rollbackCount()).toBe(1);
  });
});
