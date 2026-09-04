import { describe, expect, it } from "vitest";

import {
  anOrganization,
  anOrganizationMembership,
  aProject,
  aProjectMembership,
  OrganizationRole,
  ProjectRole,
  userId,
  type OrganizationMembershipRecord,
  type OrganizationRecord,
  type ProjectRecord,
} from "../domain/index.js";
import type { Result } from "@platos/kernel";

import {
  createListOperatorOrganizations,
  createListVisibleProjects,
  type OperatorProject,
} from "./operator-read-models.js";
import { createTenancyFixture, type TenancyFixture } from "./testing/tenant-fixture.js";

const ADA = userId("ada");
const MEL = userId("mel");
const ARCHIVED_AT = new Date("2026-02-01T00:00:00.000Z");
const REMOVED_AT = new Date("2026-01-15T00:00:00.000Z");

function put(
  fixture: TenancyFixture,
  organization: OrganizationRecord,
  member: { readonly user: string; readonly role: OrganizationRole; readonly at?: Date },
): OrganizationMembershipRecord {
  const membership = anOrganizationMembership(
    `m-${member.user}-${organization.id}`,
    organization.id,
    userId(member.user),
    { role: member.role, ...(member.at === undefined ? {} : { createdAt: member.at }) },
  );
  fixture.store.organizationMemberships.push(membership);
  return membership;
}

function project(fixture: TenancyFixture, id: string, organization: OrganizationRecord, overrides = {}) {
  const row = aProject(id, organization.id, overrides);
  fixture.store.projects.push(row);
  return row;
}

function grant(
  fixture: TenancyFixture,
  row: ProjectRecord,
  membership: OrganizationMembershipRecord,
  role = ProjectRole.VIEWER,
) {
  fixture.store.projectMemberships.push(
    aProjectMembership(`pm-${row.id}-${membership.id}`, row, membership, { role }),
  );
}

function scenario() {
  const fixture = createTenancyFixture();
  return {
    fixture,
    organizations: createListOperatorOrganizations(fixture.dependencies),
    projects: createListVisibleProjects(fixture.dependencies),
  };
}

function slugsOf(result: Result<readonly OperatorProject[]>): string[] {
  if (!result.ok) throw new Error("expected a successful read");
  return result.value.map((row) => row.project.slug);
}

describe("listOperatorOrganizations", () => {
  it("returns the organizations an operator is an active member of", async () => {
    const { fixture, organizations } = scenario();
    const acme = anOrganization("acme");
    const globex = anOrganization("globex");
    fixture.store.organizations.push(acme, globex);
    put(fixture, acme, { user: "ada", role: OrganizationRole.MEMBER });
    put(fixture, globex, { user: "ada", role: OrganizationRole.OWNER });

    const listed = await organizations(ADA);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((row) => row.organization.slug)).toEqual(["acme", "globex"]);
    expect(listed.value.map((row) => row.membership.role)).toEqual([
      OrganizationRole.MEMBER,
      OrganizationRole.OWNER,
    ]);
  });

  it("orders by membership creation, which is what decides where an operator LANDS", async () => {
    // `orderBy: { createdAt: "asc" }` on the membership query picks the
    // organization the dashboard redirects into. Reversing it sends the same
    // operator somewhere else, so the order is behaviour, not presentation.
    const { fixture, organizations } = scenario();
    const first = anOrganization("first");
    const second = anOrganization("second");
    fixture.store.organizations.push(second, first);
    put(fixture, second, {
      user: "ada",
      role: OrganizationRole.OWNER,
      at: new Date("2026-03-01T00:00:00.000Z"),
    });
    put(fixture, first, {
      user: "ada",
      role: OrganizationRole.OWNER,
      at: new Date("2026-01-01T00:00:00.000Z"),
    });

    const listed = await organizations(ADA);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((row) => row.organization.slug)).toEqual(["first", "second"]);
  });

  it("REFUSES TO LIST ANOTHER OPERATOR'S ORGANIZATIONS", async () => {
    const { fixture, organizations } = scenario();
    const acme = anOrganization("acme");
    fixture.store.organizations.push(acme);
    put(fixture, acme, { user: "mel", role: OrganizationRole.OWNER });

    expect(await organizations(ADA).then((r) => (r.ok ? r.value : null))).toEqual([]);
    expect(await organizations(MEL).then((r) => (r.ok ? r.value.length : -1))).toBe(1);
  });

  it("OMITS an archived organization and a deactivated membership", async () => {
    const { fixture, organizations } = scenario();
    const archived = anOrganization("archived", { archivedAt: ARCHIVED_AT });
    const left = anOrganization("left");
    fixture.store.organizations.push(archived, left);
    put(fixture, archived, { user: "ada", role: OrganizationRole.OWNER });
    const gone = put(fixture, left, { user: "ada", role: OrganizationRole.OWNER });
    fixture.store.organizationMemberships.splice(
      fixture.store.organizationMemberships.indexOf(gone),
      1,
      { ...gone, deactivatedAt: REMOVED_AT },
    );

    const listed = await organizations(ADA);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toEqual([]);
  });
});

describe("listVisibleProjects — the rule that used to be a Prisma where clause", () => {
  it("shows an organization ADMIN every unarchived project, and says which grant", async () => {
    const { fixture, projects } = scenario();
    const acme = anOrganization("acme");
    fixture.store.organizations.push(acme);
    put(fixture, acme, { user: "ada", role: OrganizationRole.ADMIN });
    project(fixture, "checkout", acme);
    project(fixture, "billing", acme);
    project(fixture, "retired", acme, { archivedAt: ARCHIVED_AT });

    const listed = await projects(ADA);
    expect(slugsOf(listed)).toEqual(["checkout", "billing"]);
    if (!listed.ok) return;
    expect(listed.value.every((row) => row.through === "organization-admin")).toBe(true);
  });

  it("shows a plain MEMBER only the projects they were added to", async () => {
    const { fixture, projects } = scenario();
    const acme = anOrganization("acme");
    fixture.store.organizations.push(acme);
    const membership = put(fixture, acme, { user: "ada", role: OrganizationRole.MEMBER });
    const checkout = project(fixture, "checkout", acme);
    project(fixture, "billing", acme);
    grant(fixture, checkout, membership);

    const listed = await projects(ADA);
    expect(slugsOf(listed)).toEqual(["checkout"]);
    if (!listed.ok) return;
    expect(listed.value[0]?.through).toBe("project-membership");
  });

  it("SHOWS A MEMBER NOTHING until they are added to a project", async () => {
    const { fixture, projects } = scenario();
    const acme = anOrganization("acme");
    fixture.store.organizations.push(acme);
    put(fixture, acme, { user: "ada", role: OrganizationRole.MEMBER });
    project(fixture, "checkout", acme);

    expect(slugsOf(await projects(ADA))).toEqual([]);
  });

  it("REFUSES ACROSS TENANTS — an OWNER of one organization sees none of another's", async () => {
    const { fixture, projects } = scenario();
    const acme = anOrganization("acme");
    const globex = anOrganization("globex");
    fixture.store.organizations.push(acme, globex);
    put(fixture, acme, { user: "ada", role: OrganizationRole.OWNER });
    put(fixture, globex, { user: "mel", role: OrganizationRole.OWNER });
    project(fixture, "mine", acme);
    project(fixture, "theirs", globex);

    expect(slugsOf(await projects(ADA))).toEqual(["mine"]);
    expect(slugsOf(await projects(MEL))).toEqual(["theirs"]);
  });

  it("HIDES EVERY PROJECT FROM A DEACTIVATED MEMBER whose project rows still exist", async () => {
    // The rule the store deliberately does not enforce. Both arms are covered:
    // the removed member is an ADMIN of one organization (blanket grant) and
    // holds an explicit project membership in another.
    const { fixture, projects } = scenario();
    const acme = anOrganization("acme");
    const globex = anOrganization("globex");
    fixture.store.organizations.push(acme, globex);
    const admin = put(fixture, acme, { user: "ada", role: OrganizationRole.ADMIN });
    const member = put(fixture, globex, { user: "ada", role: OrganizationRole.MEMBER });
    project(fixture, "blanket", acme);
    grant(fixture, project(fixture, "explicit", globex), member);
    expect(slugsOf(await projects(ADA))).toEqual(["blanket", "explicit"]);

    for (const row of [admin, member]) {
      const at = fixture.store.organizationMemberships.indexOf(row);
      fixture.store.organizationMemberships.splice(at, 1, { ...row, deactivatedAt: REMOVED_AT });
    }
    expect(slugsOf(await projects(ADA))).toEqual([]);
    // And nothing about the project memberships changed.
    expect(fixture.store.projectMemberships).toHaveLength(1);
  });

  it("HIDES the projects of an ARCHIVED organization, even from its OWNER", async () => {
    // The predicate is faithful to the fragment and stops at the project; this
    // filter is the read model's, exactly where `_app._index` puts it. Without
    // the composition an owner would keep seeing an archived tenant's projects
    // while `authorizeEnvironmentOperator` denied every one of them.
    const { fixture, projects } = scenario();
    const archived = anOrganization("archived", { archivedAt: ARCHIVED_AT });
    fixture.store.organizations.push(archived);
    put(fixture, archived, { user: "ada", role: OrganizationRole.OWNER });
    project(fixture, "checkout", archived);

    expect(slugsOf(await projects(ADA))).toEqual([]);
  });

  it("does not leak a project membership granted through SOMEBODY ELSE's membership", async () => {
    const { fixture, projects } = scenario();
    const acme = anOrganization("acme");
    fixture.store.organizations.push(acme);
    put(fixture, acme, { user: "ada", role: OrganizationRole.MEMBER });
    const mel = put(fixture, acme, { user: "mel", role: OrganizationRole.MEMBER });
    grant(fixture, project(fixture, "checkout", acme), mel);

    expect(slugsOf(await projects(ADA))).toEqual([]);
    expect(slugsOf(await projects(MEL))).toEqual(["checkout"]);
  });
});
