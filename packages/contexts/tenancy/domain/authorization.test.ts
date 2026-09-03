import { describe, expect, it } from "vitest";

import {
  authorizes,
  decideEnvironmentAccess,
  isEnvironmentOperatorAuthorization,
  requireAuthorization,
  type EnvironmentAuthorizationInput,
  type EnvironmentOperatorAuthorization,
} from "./authorization.js";
import { ancestryScope, type EnvironmentAncestry } from "./ancestry.js";
import {
  anEnvironment,
  anOrganization,
  anOrganizationMembership,
  aProject,
  aProjectMembership,
  environmentId,
  organizationId,
  projectId,
  userId,
} from "./record-builders.js";
import { OrganizationRole, ProjectRole } from "./roles.js";

const ARCHIVED_AT = new Date("2026-05-05T00:00:00.000Z");
const OPERATOR = { actorUserId: userId("u1"), effectiveUserId: userId("u1") };

const organization = anOrganization("acme");
const project = aProject("app", organization.id);
const environment = anEnvironment("prod", project.id);
const ancestry: EnvironmentAncestry = { organization, project, environment };

const memberMembership = anOrganizationMembership("m1", organization.id, OPERATOR.effectiveUserId, {
  role: OrganizationRole.MEMBER,
});
const adminMembership = anOrganizationMembership("m1", organization.id, OPERATOR.effectiveUserId, {
  role: OrganizationRole.ADMIN,
});

function input(overrides: Partial<EnvironmentAuthorizationInput> = {}): EnvironmentAuthorizationInput {
  return {
    ancestry,
    organizationMembership: adminMembership,
    projectMembership: null,
    operator: OPERATOR,
    access: "metadata",
    ...overrides,
  };
}

function granted(overrides: Partial<EnvironmentAuthorizationInput> = {}): EnvironmentOperatorAuthorization {
  const decision = decideEnvironmentAccess(input(overrides));
  if (!decision.ok) throw new Error(`expected a grant, got ${decision.error.code}`);
  return decision.value;
}

describe("gate 1 — archival", () => {
  // NEGATIVE CONTROL: an archived ancestor at EACH of the three levels denies.
  it.each([
    ["organization", { organization: { ...organization, archivedAt: ARCHIVED_AT } }],
    ["project", { project: { ...project, archivedAt: ARCHIVED_AT } }],
    ["environment", { environment: { ...environment, archivedAt: ARCHIVED_AT } }],
  ])("denies when the %s is archived", (_level, patch) => {
    const decision = decideEnvironmentAccess(input({ ancestry: { ...ancestry, ...patch } }));
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
    expect(decision.error.details).toEqual({ gate: "archived-ancestor" });
  });

  it("denies a missing environment with the SAME error as an archived one", () => {
    const missing = decideEnvironmentAccess(input({ ancestry: null }));
    const archived = decideEnvironmentAccess(
      input({ ancestry: { ...ancestry, environment: { ...environment, archivedAt: ARCHIVED_AT } } }),
    );
    expect(missing.ok).toBe(false);
    if (missing.ok || archived.ok) throw new Error("unreachable");
    // Indistinguishable on the wire: probing cannot enumerate environment ids.
    expect(missing.error.code).toBe(archived.error.code);
    expect(missing.error.message).toBe(archived.error.message);
  });

  it("denies an ancestry whose rows are not really parent and child", () => {
    const stranger = anOrganization("rival");
    const decision = decideEnvironmentAccess(
      input({ ancestry: { ...ancestry, organization: stranger } }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.details).toEqual({ gate: "inconsistent-ancestry" });
  });
});

describe("gate 2 — active organization membership", () => {
  it("denies when there is no membership at all", () => {
    const decision = decideEnvironmentAccess(input({ organizationMembership: null }));
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.details).toEqual({ gate: "organization-membership" });
  });

  // NEGATIVE CONTROL: a deactivated membership denies.
  it("denies a deactivated membership", () => {
    const decision = decideEnvironmentAccess(
      input({ organizationMembership: { ...adminMembership, deactivatedAt: ARCHIVED_AT } }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.details).toEqual({ gate: "organization-membership" });
  });

  it("denies a membership belonging to a different organization", () => {
    const decision = decideEnvironmentAccess(
      input({
        organizationMembership: {
          ...adminMembership,
          organizationId: organizationId("rival"),
        },
      }),
    );
    expect(decision.ok).toBe(false);
  });

  it("denies a membership belonging to a different user", () => {
    const decision = decideEnvironmentAccess(
      input({ organizationMembership: { ...adminMembership, userId: userId("someone-else") } }),
    );
    expect(decision.ok).toBe(false);
  });
});

describe("gate 3 — project membership", () => {
  it("grants an organization OWNER or ADMIN with no project membership", () => {
    expect(granted({ organizationMembership: adminMembership }).projectRole).toBeNull();
    expect(
      granted({
        organizationMembership: { ...adminMembership, role: OrganizationRole.OWNER },
      }).organizationRole,
    ).toBe(OrganizationRole.OWNER);
  });

  // NEGATIVE CONTROL: a non-admin with no project membership is denied.
  it("denies a plain MEMBER with no project membership", () => {
    const decision = decideEnvironmentAccess(
      input({ organizationMembership: memberMembership, projectMembership: null }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.details).toEqual({ gate: "project-membership" });
  });

  it("grants a plain MEMBER who holds any project membership", () => {
    const authorization = granted({
      organizationMembership: memberMembership,
      projectMembership: aProjectMembership("pm", project, memberMembership, {
        role: ProjectRole.VIEWER,
      }),
    });
    expect(authorization.projectRole).toBe(ProjectRole.VIEWER);
  });

  it("denies a project membership for a different project", () => {
    const otherProject = aProject("other", organization.id, { id: projectId("other") });
    const decision = decideEnvironmentAccess(
      input({
        organizationMembership: memberMembership,
        projectMembership: aProjectMembership("pm", otherProject, memberMembership),
      }),
    );
    expect(decision.ok).toBe(false);
  });
});

describe("gate 4 — secret:mutate", () => {
  it("grants secret:mutate to an organization admin", () => {
    expect(granted({ access: "secret:mutate" }).access).toBe("secret:mutate");
  });

  it("grants secret:mutate to a project ADMIN who is only an organization MEMBER", () => {
    const authorization = granted({
      access: "secret:mutate",
      organizationMembership: memberMembership,
      projectMembership: aProjectMembership("pm", project, memberMembership, {
        role: ProjectRole.ADMIN,
      }),
    });
    expect(authorization.projectRole).toBe(ProjectRole.ADMIN);
  });

  // NEGATIVE CONTROL: secret:mutate denies a project EDITOR...
  it("denies secret:mutate to a project EDITOR", () => {
    const decision = decideEnvironmentAccess(
      input({
        access: "secret:mutate",
        organizationMembership: memberMembership,
        projectMembership: aProjectMembership("pm", project, memberMembership, {
          role: ProjectRole.EDITOR,
        }),
      }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.details).toEqual({ gate: "secret-mutate-role" });
  });

  // ...identically to a VIEWER, which is the EDITOR/VIEWER gap made visible.
  it("denies secret:mutate to a project VIEWER in exactly the same way", () => {
    const forRole = (role: ProjectRole) =>
      decideEnvironmentAccess(
        input({
          access: "secret:mutate",
          organizationMembership: memberMembership,
          projectMembership: aProjectMembership("pm", project, memberMembership, { role }),
        }),
      );
    const editor = forRole(ProjectRole.EDITOR);
    const viewer = forRole(ProjectRole.VIEWER);
    expect(editor.ok).toBe(false);
    expect(viewer.ok).toBe(false);
    if (editor.ok || viewer.ok) throw new Error("unreachable");
    expect(editor.error).toEqual(viewer.error);
  });

  it("still grants metadata to a project EDITOR", () => {
    const authorization = granted({
      access: "metadata",
      organizationMembership: memberMembership,
      projectMembership: aProjectMembership("pm", project, memberMembership, {
        role: ProjectRole.EDITOR,
      }),
    });
    expect(authorization.access).toBe("metadata");
  });
});

describe("the authorization value itself", () => {
  it("re-derives its scope from the ancestry, never from the caller", () => {
    const authorization = granted();
    expect(authorization.scope).toEqual(ancestryScope(ancestry));
    expect(authorizes(authorization, ancestryScope(ancestry))).toBe(true);
    expect(
      authorizes(authorization, {
        level: "environment",
        organizationId: organization.id,
        projectId: project.id,
        environmentId: environmentId("someone-elses"),
      }),
    ).toBe(false);
  });

  it("preserves the acting principal through impersonation", () => {
    const impersonating = {
      actorUserId: userId("platform-operator"),
      effectiveUserId: OPERATOR.effectiveUserId,
    };
    const authorization = granted({ operator: impersonating });
    expect(authorization.actorUserId).toBe(impersonating.actorUserId);
    expect(authorization.effectiveUserId).toBe(impersonating.effectiveUserId);
  });

  it("is frozen, so it cannot be upgraded after it was issued", () => {
    const authorization = granted({ access: "metadata" });
    expect(Object.isFrozen(authorization)).toBe(true);
    expect(() => {
      Object.assign(authorization, { access: "secret:mutate" });
    }).toThrow(TypeError);
    expect(authorization.access).toBe("metadata");
  });

  it("accepts a value it minted", () => {
    const authorization = granted();
    expect(isEnvironmentOperatorAuthorization(authorization)).toBe(true);
    expect(requireAuthorization(authorization).ok).toBe(true);
  });

  // NEGATIVE CONTROL: a forged object literal is rejected. The compile-time
  // brand already makes this a type error without the `as unknown` below — the
  // cast is what lets the RUN-TIME half be exercised at all.
  it("rejects a forged object literal", () => {
    const forged = {
      principalType: "operator",
      tier: "OPERATOR",
      access: "secret:mutate",
      scope: ancestryScope(ancestry),
      actorUserId: userId("attacker"),
      effectiveUserId: userId("attacker"),
      organizationRole: OrganizationRole.OWNER,
      projectRole: ProjectRole.ADMIN,
    } as unknown;
    expect(isEnvironmentOperatorAuthorization(forged)).toBe(false);
    const checked = requireAuthorization(forged);
    expect(checked.ok).toBe(false);
    if (checked.ok) throw new Error("unreachable");
    expect(checked.error.code).toBe("TENANCY_AUTHORIZATION_FORGED");
  });

  it("rejects a FROZEN forgery, and a genuine value copied field by field", () => {
    const authorization = granted();
    // Freezing is necessary but not sufficient: the run-time mark is private.
    expect(isEnvironmentOperatorAuthorization(Object.freeze({ ...authorization }))).toBe(false);
    expect(isEnvironmentOperatorAuthorization(JSON.parse(JSON.stringify(authorization)))).toBe(false);
  });

  it("rejects non-objects", () => {
    for (const value of [null, undefined, "authorized", 1, true, []]) {
      expect(isEnvironmentOperatorAuthorization(value)).toBe(false);
    }
  });
});
