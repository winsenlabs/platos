import { describe, expect, it } from "vitest";

import {
  anOrganization,
  anOrganizationMembership,
  aProject,
  aProjectMembership,
  organizationId,
  userId,
} from "./record-builders.js";
import { OrganizationRole, ProjectRole } from "./roles.js";
import { organizationIsListable, projectVisibility } from "./visibility.js";

const ADA = userId("ada");
const ARCHIVED_AT = new Date("2026-02-01T00:00:00.000Z");
const REMOVED_AT = new Date("2026-01-15T00:00:00.000Z");

const acme = anOrganization("acme");
const project = aProject("checkout", acme.id);

function membership(role: OrganizationRole, overrides = {}) {
  return anOrganizationMembership("m-ada", acme.id, ADA, { role, ...overrides });
}

describe("projectVisibility — the rule ported from operatorVisibleProjectWhere", () => {
  it("shows an organization OWNER every unarchived project, with no project membership", () => {
    expect(
      projectVisibility({
        project,
        organizationMembership: membership(OrganizationRole.OWNER),
        projectMemberships: [],
      }),
    ).toBe("organization-admin");
  });

  it("shows an organization ADMIN the same blanket grant", () => {
    expect(
      projectVisibility({
        project,
        organizationMembership: membership(OrganizationRole.ADMIN),
        projectMemberships: [],
      }),
    ).toBe("organization-admin");
  });

  it("HIDES a project from a plain MEMBER who holds no project membership", () => {
    // The whole point of the second arm. A MEMBER is inside the organization and
    // still sees nothing until somebody adds them to a project.
    expect(
      projectVisibility({
        project,
        organizationMembership: membership(OrganizationRole.MEMBER),
        projectMemberships: [],
      }),
    ).toBeNull();
  });

  it("shows a plain MEMBER exactly the project they hold a membership on", () => {
    const holder = membership(OrganizationRole.MEMBER);
    expect(
      projectVisibility({
        project,
        organizationMembership: holder,
        projectMemberships: [aProjectMembership("pm", project, holder, { role: ProjectRole.VIEWER })],
      }),
    ).toBe("project-membership");
  });

  it("HIDES a project whose membership belongs to a DIFFERENT project", () => {
    // `some({ organizationMembership: { userId } })` is scoped to the project row
    // it hangs off. A predicate that only asked "does this user hold any project
    // membership?" would show every project in the organization.
    const holder = membership(OrganizationRole.MEMBER);
    const other = aProject("billing", acme.id);
    expect(
      projectVisibility({
        project,
        organizationMembership: holder,
        projectMemberships: [aProjectMembership("pm", other, holder, {})],
      }),
    ).toBeNull();
  });

  it("HIDES a project whose membership was granted through ANOTHER organization membership", () => {
    const holder = membership(OrganizationRole.MEMBER);
    const impostor = anOrganizationMembership("m-other", acme.id, userId("mel"), {});
    expect(
      projectVisibility({
        project,
        organizationMembership: holder,
        projectMemberships: [aProjectMembership("pm", project, impostor, {})],
      }),
    ).toBeNull();
  });

  it("HIDES EVERY PROJECT FROM A DEACTIVATED MEMBER, project rows untouched", () => {
    // The deactivation clause sits on the ORGANIZATION membership in both arms,
    // so removing somebody hides everything at once without rewriting a single
    // `ProjectMembership`. Both arms are checked, because the clause appears
    // twice in the fragment and deleting it from one is a silent leak.
    const admin = membership(OrganizationRole.ADMIN, { deactivatedAt: REMOVED_AT });
    const member = membership(OrganizationRole.MEMBER, { deactivatedAt: REMOVED_AT });
    expect(
      projectVisibility({ project, organizationMembership: admin, projectMemberships: [] }),
    ).toBeNull();
    expect(
      projectVisibility({
        project,
        organizationMembership: member,
        projectMemberships: [aProjectMembership("pm", project, member, {})],
      }),
    ).toBeNull();
  });

  it("HIDES an ARCHIVED project, even from an OWNER", () => {
    expect(
      projectVisibility({
        project: aProject("checkout", acme.id, { archivedAt: ARCHIVED_AT }),
        organizationMembership: membership(OrganizationRole.OWNER),
        projectMemberships: [],
      }),
    ).toBeNull();
  });

  it("HIDES a project from somebody with no membership at all", () => {
    expect(
      projectVisibility({ project, organizationMembership: null, projectMemberships: [] }),
    ).toBeNull();
  });

  it("HIDES ACROSS TENANTS — an OWNER of another organization sees nothing here", () => {
    const rival = anOrganizationMembership("m-rival", organizationId("rival"), ADA, {
      role: OrganizationRole.OWNER,
    });
    expect(
      projectVisibility({ project, organizationMembership: rival, projectMemberships: [] }),
    ).toBeNull();
  });

  it("reports an admin who ALSO holds a project membership as an admin", () => {
    // A row satisfying both arms of the `OR` is returned once, and the stronger
    // grant is the true answer: revoking their project membership changes
    // nothing about what they can see.
    const admin = membership(OrganizationRole.ADMIN);
    expect(
      projectVisibility({
        project,
        organizationMembership: admin,
        projectMemberships: [aProjectMembership("pm", project, admin, {})],
      }),
    ).toBe("organization-admin");
  });
});

describe("organizationIsListable — the _app._index membership query", () => {
  it("lists an organization for any active role, admin or not", () => {
    for (const role of [OrganizationRole.OWNER, OrganizationRole.ADMIN, OrganizationRole.MEMBER]) {
      expect(organizationIsListable(acme, membership(role), ADA)).toBe(true);
    }
  });

  it("REFUSES an ARCHIVED organization — this is where that filter lives", () => {
    expect(
      organizationIsListable(
        anOrganization("acme", { archivedAt: ARCHIVED_AT }),
        membership(OrganizationRole.OWNER),
        ADA,
      ),
    ).toBe(false);
  });

  it("REFUSES a deactivated membership", () => {
    expect(
      organizationIsListable(acme, membership(OrganizationRole.OWNER, { deactivatedAt: REMOVED_AT }), ADA),
    ).toBe(false);
  });

  it("REFUSES a membership belonging to somebody else, or to another organization", () => {
    expect(organizationIsListable(acme, membership(OrganizationRole.OWNER), userId("mel"))).toBe(false);
    expect(
      organizationIsListable(
        anOrganization("globex"),
        membership(OrganizationRole.OWNER),
        ADA,
      ),
    ).toBe(false);
  });
});

describe("the two rules are NOT the same rule", () => {
  it("lists an organization for a MEMBER who can see none of its projects", () => {
    // The distinction the single Prisma query hid. A plain MEMBER with no
    // project membership belongs on their organization list and sees zero
    // projects inside it — which is exactly the state `_app._index` redirects to
    // `/orgs/new` from, and would be unreachable if one predicate served both.
    const plain = membership(OrganizationRole.MEMBER);
    expect(organizationIsListable(acme, plain, ADA)).toBe(true);
    expect(
      projectVisibility({ project, organizationMembership: plain, projectMemberships: [] }),
    ).toBeNull();
  });

  it("shows a project inside an organization that is NOT listable", () => {
    // The fragment says nothing about the organization, so the predicate does
    // not either. Composing the two is the read model's job, and this is the
    // case that proves the composition is load-bearing rather than decorative.
    const archived = anOrganization("acme", { archivedAt: ARCHIVED_AT });
    const owner = membership(OrganizationRole.OWNER);
    expect(organizationIsListable(archived, owner, ADA)).toBe(false);
    expect(
      projectVisibility({
        project: aProject("checkout", archived.id),
        organizationMembership: owner,
        projectMemberships: [],
      }),
    ).toBe("organization-admin");
  });
});
