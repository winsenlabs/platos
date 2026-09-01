// The four gates again, this time END TO END through the use case and an
// in-memory repository — no database, no framework, no network.
//
// The domain test proves the decision; this one proves the WIRING: that the
// ancestry really is re-derived from the environment id, that the membership
// lookups are keyed off that re-derived ancestry, and that a caller has nowhere
// to put a tenant id of its own choosing.

import { describe, expect, it } from "vitest";

import {
  anOrganizationMembership,
  aProjectMembership,
  environmentId,
  isEnvironmentOperatorAuthorization,
  OrganizationRole,
  ProjectRole,
  userId,
} from "../domain/index.js";
import { createAuthorizeEnvironmentOperator } from "./authorize-environment-operator.js";
import { createTenancyFixture, seedTree } from "./testing/tenant-fixture.js";

const ARCHIVED_AT = new Date("2026-05-05T00:00:00.000Z");
const OPERATOR = { actorUserId: userId("ada"), effectiveUserId: userId("ada") };

function scenario(options: {
  readonly organizationRole?: OrganizationRole;
  readonly projectRole?: ProjectRole;
  readonly withProjectMembership?: boolean;
  readonly deactivated?: boolean;
  readonly archive?: "organization" | "project" | "environment";
}) {
  const fixture = createTenancyFixture();
  const tree = seedTree(fixture.store);
  if (options.archive === "organization") {
    fixture.store.organizations = [{ ...tree.organization, archivedAt: ARCHIVED_AT }];
  }
  if (options.archive === "project") {
    fixture.store.projects = [{ ...tree.project, archivedAt: ARCHIVED_AT }];
  }
  if (options.archive === "environment") {
    fixture.store.environments = [{ ...tree.environment, archivedAt: ARCHIVED_AT }];
  }

  const membership = anOrganizationMembership("m1", tree.organization.id, OPERATOR.effectiveUserId, {
    role: options.organizationRole ?? OrganizationRole.MEMBER,
    deactivatedAt: options.deactivated === true ? ARCHIVED_AT : null,
  });
  fixture.store.organizationMemberships.push(membership);
  if (options.withProjectMembership === true) {
    fixture.store.projectMemberships.push(
      aProjectMembership("pm1", tree.project, membership, {
        role: options.projectRole ?? ProjectRole.VIEWER,
      }),
    );
  }
  return {
    tree,
    authorize: createAuthorizeEnvironmentOperator(fixture.dependencies),
  };
}

describe("authorizeEnvironmentOperator", () => {
  it("grants an organization ADMIN with no project membership", async () => {
    const { tree, authorize } = scenario({ organizationRole: OrganizationRole.ADMIN });
    const result = await authorize({
      environmentId: tree.environment.id,
      operator: OPERATOR,
      access: "metadata",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(isEnvironmentOperatorAuthorization(result.value)).toBe(true);
    expect(result.value.scope).toEqual({
      level: "environment",
      organizationId: tree.organization.id,
      projectId: tree.project.id,
      environmentId: tree.environment.id,
    });
  });

  // NEGATIVE CONTROL: an archived ancestor at EACH of the three levels denies.
  it.each(["organization", "project", "environment"] as const)(
    "denies when the %s is archived",
    async (level) => {
      const { tree, authorize } = scenario({
        organizationRole: OrganizationRole.OWNER,
        archive: level,
      });
      const result = await authorize({
        environmentId: tree.environment.id,
        operator: OPERATOR,
        access: "metadata",
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
      expect(result.error.details).toEqual({ gate: "archived-ancestor" });
    },
  );

  // NEGATIVE CONTROL: a deactivated membership denies.
  it("denies a deactivated organization membership", async () => {
    const { tree, authorize } = scenario({
      organizationRole: OrganizationRole.ADMIN,
      deactivated: true,
    });
    const result = await authorize({
      environmentId: tree.environment.id,
      operator: OPERATOR,
      access: "metadata",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.details).toEqual({ gate: "organization-membership" });
  });

  // NEGATIVE CONTROL: a non-admin with no project membership denies.
  it("denies an organization MEMBER with no project membership", async () => {
    const { tree, authorize } = scenario({ organizationRole: OrganizationRole.MEMBER });
    const result = await authorize({
      environmentId: tree.environment.id,
      operator: OPERATOR,
      access: "metadata",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.details).toEqual({ gate: "project-membership" });
  });

  // NEGATIVE CONTROL: secret:mutate denies a project EDITOR.
  it("denies secret:mutate to a project EDITOR", async () => {
    const { tree, authorize } = scenario({
      organizationRole: OrganizationRole.MEMBER,
      withProjectMembership: true,
      projectRole: ProjectRole.EDITOR,
    });
    const result = await authorize({
      environmentId: tree.environment.id,
      operator: OPERATOR,
      access: "secret:mutate",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.details).toEqual({ gate: "secret-mutate-role" });
  });

  it("grants metadata to that same project EDITOR", async () => {
    const { tree, authorize } = scenario({
      organizationRole: OrganizationRole.MEMBER,
      withProjectMembership: true,
      projectRole: ProjectRole.EDITOR,
    });
    const result = await authorize({
      environmentId: tree.environment.id,
      operator: OPERATOR,
      access: "metadata",
    });
    expect(result.ok).toBe(true);
  });

  it("grants secret:mutate to a project ADMIN who is only an organization MEMBER", async () => {
    const { tree, authorize } = scenario({
      organizationRole: OrganizationRole.MEMBER,
      withProjectMembership: true,
      projectRole: ProjectRole.ADMIN,
    });
    const result = await authorize({
      environmentId: tree.environment.id,
      operator: OPERATOR,
      access: "secret:mutate",
    });
    expect(result.ok).toBe(true);
  });

  it("denies an unknown environment with the archival error, leaking nothing", async () => {
    const { authorize } = scenario({ organizationRole: OrganizationRole.OWNER });
    const result = await authorize({
      environmentId: environmentId("no-such-environment"),
      operator: OPERATOR,
      access: "metadata",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.details).toEqual({ gate: "archived-ancestor" });
  });

  // Cross-tenant: a member of another organization presenting a valid
  // environment id of this one gets nothing, because the membership lookup is
  // keyed off the RE-DERIVED organization rather than anything they supplied.
  it("denies an operator whose membership is in a different organization", async () => {
    const fixture = createTenancyFixture();
    const mine = seedTree(fixture.store, "acme");
    const theirs = seedTree(fixture.store, "rival");
    fixture.store.organizationMemberships.push(
      anOrganizationMembership("m-rival", theirs.organization.id, OPERATOR.effectiveUserId, {
        role: OrganizationRole.OWNER,
      }),
    );
    const authorize = createAuthorizeEnvironmentOperator(fixture.dependencies);
    const result = await authorize({
      environmentId: mine.environment.id,
      operator: OPERATOR,
      access: "metadata",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.details).toEqual({ gate: "organization-membership" });
  });
});
