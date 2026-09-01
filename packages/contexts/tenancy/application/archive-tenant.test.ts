import { describe, expect, it } from "vitest";

import {
  anOrganizationMembership,
  OrganizationRole,
  userId,
} from "../domain/index.js";
import {
  createArchiveEnvironment,
  createArchiveOrganization,
  createArchiveProject,
  createResolveEnvironmentScope,
} from "./archive-tenant.js";
import { createAuthorizeEnvironmentOperator } from "./authorize-environment-operator.js";
import { createTenancyFixture, seedTree } from "./testing/tenant-fixture.js";

const OWNER = userId("owner");
const MEMBER = userId("member");

function scenario() {
  const fixture = createTenancyFixture();
  const tree = seedTree(fixture.store);
  fixture.store.organizationMemberships.push(
    anOrganizationMembership("m-owner", tree.organization.id, OWNER, {
      role: OrganizationRole.OWNER,
    }),
    anOrganizationMembership("m-member", tree.organization.id, MEMBER, {
      role: OrganizationRole.MEMBER,
    }),
  );
  return { fixture, tree };
}

describe("archival", () => {
  // Archiving ONE row at the top denies every environment beneath it, without a
  // single descendant write.
  it("denies an environment as soon as its organization is archived", async () => {
    const { fixture, tree } = scenario();
    const authorize = createAuthorizeEnvironmentOperator(fixture.dependencies);
    const operator = { actorUserId: OWNER, effectiveUserId: OWNER };

    expect((await authorize({ environmentId: tree.environment.id, operator, access: "metadata" })).ok).toBe(true);

    const archive = createArchiveOrganization(fixture.dependencies);
    expect((await archive({ organizationId: tree.organization.id, actorUserId: OWNER })).ok).toBe(true);

    // One row changed; no project or environment row was rewritten.
    expect(fixture.store.organizations[0]?.archivedAt).not.toBeNull();
    expect(fixture.store.projects[0]?.archivedAt).toBeNull();
    expect(fixture.store.environments[0]?.archivedAt).toBeNull();

    const denied = await authorize({ environmentId: tree.environment.id, operator, access: "metadata" });
    expect(denied.ok).toBe(false);
  });

  it("archives a project without touching its organization", async () => {
    const { fixture, tree } = scenario();
    const archive = createArchiveProject(fixture.dependencies);
    expect((await archive({ projectId: tree.project.id, actorUserId: OWNER })).ok).toBe(true);
    expect(fixture.store.projects[0]?.archivedAt).not.toBeNull();
    expect(fixture.store.organizations[0]?.archivedAt).toBeNull();

    const resolve = createResolveEnvironmentScope(fixture.dependencies);
    const resolved = await resolve(tree.environment.id);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.archived).toBe("project");
  });

  it("archives an environment, resolving its ancestry from the leaf id", async () => {
    const { fixture, tree } = scenario();
    const archive = createArchiveEnvironment(fixture.dependencies);
    expect((await archive({ environmentId: tree.environment.id, actorUserId: OWNER })).ok).toBe(true);
    expect(fixture.store.environments[0]?.archivedAt).not.toBeNull();
  });

  it("refuses an organization MEMBER archiving anything", async () => {
    const { fixture, tree } = scenario();
    const organization = await createArchiveOrganization(fixture.dependencies)({
      organizationId: tree.organization.id,
      actorUserId: MEMBER,
    });
    const project = await createArchiveProject(fixture.dependencies)({
      projectId: tree.project.id,
      actorUserId: MEMBER,
    });
    const environment = await createArchiveEnvironment(fixture.dependencies)({
      environmentId: tree.environment.id,
      actorUserId: MEMBER,
    });
    for (const result of [organization, project, environment]) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("TENANCY_MEMBERSHIP_FORBIDDEN");
    }
    expect(fixture.store.organizations[0]?.archivedAt).toBeNull();
  });

  it("refuses to archive what does not exist", async () => {
    const { fixture, tree } = scenario();
    const rival = seedTree(fixture.store, "rival");
    // The actor is an owner of acme, so archiving rival's project is refused
    // for authorization, not because the row is missing.
    const result = await createArchiveProject(fixture.dependencies)({
      projectId: rival.project.id,
      actorUserId: OWNER,
    });
    expect(result.ok).toBe(false);
    expect(tree.project.id).not.toBe(rival.project.id);
  });
});
