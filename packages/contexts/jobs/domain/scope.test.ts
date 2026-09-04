import { asIdentifier, environmentScope, organizationScope, projectScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { environmentFallsWithin, environmentPath, sameEnvironment } from "./scope.js";

function env(organization = "org-1", project = "proj-1", environment = "env-1") {
  return environmentScope(
    asIdentifier(organization),
    asIdentifier(project),
    asIdentifier(environment),
  );
}

describe("environmentPath", () => {
  it("is the kernel's canonical form", () => {
    expect(environmentPath(env())).toBe("org/org-1/proj/proj-1/env/env-1");
  });
});

describe("sameEnvironment", () => {
  it("is true for the same triple", () => {
    expect(sameEnvironment(env(), env())).toBe(true);
  });

  it.each([
    ["organization", env("org-2")],
    ["project", env("org-1", "proj-2")],
    ["environment", env("org-1", "proj-1", "env-2")],
  ])("is false when the %s differs", (_label, other) => {
    expect(sameEnvironment(env(), other)).toBe(false);
  });
});

describe("environmentFallsWithin", () => {
  it("matches an environment against its own organization", () => {
    expect(environmentFallsWithin(organizationScope(asIdentifier("org-1")), env())).toBe(true);
  });

  it("matches an environment against its own project", () => {
    expect(
      environmentFallsWithin(projectScope(asIdentifier("org-1"), asIdentifier("proj-1")), env()),
    ).toBe(true);
  });

  it("matches an environment against itself", () => {
    expect(environmentFallsWithin(env(), env())).toBe(true);
  });

  it("REFUSES an environment in another organization", () => {
    expect(environmentFallsWithin(organizationScope(asIdentifier("org-2")), env())).toBe(false);
  });

  it("REFUSES an environment in a sibling project", () => {
    expect(
      environmentFallsWithin(projectScope(asIdentifier("org-1"), asIdentifier("proj-2")), env()),
    ).toBe(false);
  });

  it("is not fooled by an id that merely starts the same", () => {
    // `org-1` must not contain `org-10`: the separator is what makes the
    // containment check a tree walk rather than a string prefix.
    expect(environmentFallsWithin(organizationScope(asIdentifier("org-1")), env("org-10"))).toBe(false);
  });

  it("is not fooled by a project id that merely starts the same", () => {
    expect(
      environmentFallsWithin(projectScope(asIdentifier("org-1"), asIdentifier("proj-1")), env("org-1", "proj-10")),
    ).toBe(false);
  });
});
