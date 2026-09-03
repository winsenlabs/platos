import { environmentScope, organizationScope, projectScope, resolvePath } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  ancestryContains,
  ancestryScope,
  ancestryWithin,
  archivedAncestor,
  isAncestryConsistent,
  isAncestryLive,
  type EnvironmentAncestry,
} from "./ancestry.js";
import { anEnvironment, anOrganization, aProject, projectId } from "./record-builders.js";
import { resolveScopePathFor } from "./scope-path.js";

const ARCHIVED_AT = new Date("2026-02-02T00:00:00.000Z");

function tree(overrides: Partial<EnvironmentAncestry> = {}): EnvironmentAncestry {
  const organization = anOrganization("acme");
  const project = aProject("app", organization.id);
  const environment = anEnvironment("prod", project.id);
  return { organization, project, environment, ...overrides };
}

describe("ancestry", () => {
  it("resolves the environment scope from the three rows", () => {
    const ancestry = tree();
    expect(ancestryScope(ancestry)).toEqual(
      environmentScope(ancestry.organization.id, ancestry.project.id, ancestry.environment.id),
    );
    expect(resolveScopePathFor(ancestry)).toBe("org/acme/proj/app/env/prod");
    expect(resolveScopePathFor(ancestryScope(ancestry))).toBe(resolveScopePathFor(ancestry));
  });

  it("uses the kernel containment predicate rather than comparing ids", () => {
    const ancestry = tree();
    expect(ancestryWithin(ancestry, organizationScope(ancestry.organization.id))).toBe(true);
    expect(ancestryWithin(ancestry, projectScope(ancestry.organization.id, ancestry.project.id))).toBe(true);
    expect(ancestryContains(ancestry, ancestryScope(ancestry))).toBe(true);
    // A sibling project of the same organization does NOT contain this environment.
    expect(ancestryWithin(ancestry, projectScope(ancestry.organization.id, projectId("other")))).toBe(false);
    expect(resolvePath(ancestryScope(ancestry)).startsWith("org/acme/")).toBe(true);
  });

  it("reports no archived ancestor for a live tree", () => {
    expect(archivedAncestor(tree())).toBeNull();
    expect(isAncestryLive(tree())).toBe(true);
  });

  // NEGATIVE CONTROL: archival at each of the three levels, independently.
  it("reports the archived level when the organization is archived", () => {
    const base = tree();
    const ancestry = { ...base, organization: { ...base.organization, archivedAt: ARCHIVED_AT } };
    expect(archivedAncestor(ancestry)).toBe("organization");
    expect(isAncestryLive(ancestry)).toBe(false);
  });

  it("reports the archived level when the project is archived", () => {
    const base = tree();
    const ancestry = { ...base, project: { ...base.project, archivedAt: ARCHIVED_AT } };
    expect(archivedAncestor(ancestry)).toBe("project");
  });

  it("reports the archived level when the environment is archived", () => {
    const base = tree();
    const ancestry = { ...base, environment: { ...base.environment, archivedAt: ARCHIVED_AT } };
    expect(archivedAncestor(ancestry)).toBe("environment");
  });

  it("reports the WIDEST archived ancestor when more than one is archived", () => {
    const base = tree();
    const ancestry = {
      organization: { ...base.organization, archivedAt: ARCHIVED_AT },
      project: { ...base.project, archivedAt: ARCHIVED_AT },
      environment: { ...base.environment, archivedAt: ARCHIVED_AT },
    };
    expect(archivedAncestor(ancestry)).toBe("organization");
  });

  it("rejects an ancestry whose rows are not actually parent and child", () => {
    const base = tree();
    const stranger = anOrganization("other");
    expect(isAncestryConsistent(base)).toBe(true);
    expect(isAncestryConsistent({ ...base, organization: stranger })).toBe(false);
    expect(
      isAncestryConsistent({
        ...base,
        environment: { ...base.environment, projectId: projectId("elsewhere") },
      }),
    ).toBe(false);
  });
});
