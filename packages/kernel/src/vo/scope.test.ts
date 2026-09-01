import { describe, expect, it } from "vitest";

import { asIdentifier } from "./identifier.js";
import type { EnvironmentId, OrganizationId, ProjectId } from "./identifier.js";
import {
  contains,
  environmentScope,
  organizationScope,
  projectScope,
  resolvePath,
  toOrganizationScope,
} from "./scope.js";

const org = asIdentifier<OrganizationId>("org-1");
const otherOrg = asIdentifier<OrganizationId>("org-2");
const project = asIdentifier<ProjectId>("proj-1");
const otherProject = asIdentifier<ProjectId>("proj-2");
const environment = asIdentifier<EnvironmentId>("env-1");
const otherEnvironment = asIdentifier<EnvironmentId>("env-2");

describe("resolvePath is the one canonical scope key", () => {
  it("renders each level", () => {
    expect(resolvePath(organizationScope(org))).toBe("org/org-1");
    expect(resolvePath(projectScope(org, project))).toBe("org/org-1/proj/proj-1");
    expect(resolvePath(environmentScope(org, project, environment))).toBe(
      "org/org-1/proj/proj-1/env/env-1",
    );
  });

  it("is injective across levels, so two scopes never share a cache key", () => {
    const paths = [
      resolvePath(organizationScope(org)),
      resolvePath(projectScope(org, project)),
      resolvePath(environmentScope(org, project, environment)),
      resolvePath(organizationScope(otherOrg)),
      resolvePath(projectScope(org, otherProject)),
      resolvePath(environmentScope(org, project, otherEnvironment)),
    ];
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("containment is the whole of the cross-scope decision", () => {
  it("a scope contains itself", () => {
    const scope = environmentScope(org, project, environment);
    expect(contains(scope, scope)).toBe(true);
  });

  it("an ancestor contains its descendants", () => {
    expect(contains(organizationScope(org), projectScope(org, project))).toBe(true);
    expect(contains(organizationScope(org), environmentScope(org, project, environment))).toBe(true);
    expect(contains(projectScope(org, project), environmentScope(org, project, environment))).toBe(true);
  });

  it("a descendant does NOT contain its ancestor", () => {
    expect(contains(projectScope(org, project), organizationScope(org))).toBe(false);
    expect(contains(environmentScope(org, project, environment), projectScope(org, project))).toBe(false);
  });

  it("denies every sibling across every level", () => {
    expect(contains(organizationScope(org), organizationScope(otherOrg))).toBe(false);
    expect(contains(organizationScope(org), projectScope(otherOrg, project))).toBe(false);
    expect(contains(projectScope(org, project), projectScope(org, otherProject))).toBe(false);
    expect(contains(projectScope(org, project), environmentScope(org, otherProject, environment))).toBe(false);
    expect(
      contains(
        environmentScope(org, project, environment),
        environmentScope(org, project, otherEnvironment),
      ),
    ).toBe(false);
  });

  it("is not fooled by an identifier that prefixes another", () => {
    // "org/org-1" must not be judged to contain "org/org-10".
    const longer = asIdentifier<OrganizationId>("org-10");
    expect(contains(organizationScope(org), organizationScope(longer))).toBe(false);
  });

  it("widens to the owning organization", () => {
    expect(toOrganizationScope(environmentScope(org, project, environment))).toEqual(
      organizationScope(org),
    );
  });
});
