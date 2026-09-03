import { describe, expect, it } from "vitest";

import {
  ORGANIZATION_ROLES,
  OrganizationRole,
  PROJECT_ROLES,
  PrincipalTier,
  ProjectRole,
  isOrganizationAdmin,
  isOrganizationRole,
  isProjectAdmin,
  isProjectRole,
} from "./roles.js";

describe("organization roles", () => {
  it("treats OWNER and ADMIN as organization admins and MEMBER as not", () => {
    expect(isOrganizationAdmin(OrganizationRole.OWNER)).toBe(true);
    expect(isOrganizationAdmin(OrganizationRole.ADMIN)).toBe(true);
    expect(isOrganizationAdmin(OrganizationRole.MEMBER)).toBe(false);
  });

  it("enumerates exactly the three schema values", () => {
    expect([...ORGANIZATION_ROLES]).toEqual(["OWNER", "ADMIN", "MEMBER"]);
    expect(isOrganizationRole("OWNER")).toBe(true);
    expect(isOrganizationRole("SUPERUSER")).toBe(false);
  });
});

describe("project roles", () => {
  it("enumerates exactly the three schema values", () => {
    expect([...PROJECT_ROLES]).toEqual(["ADMIN", "EDITOR", "VIEWER"]);
    expect(isProjectRole("EDITOR")).toBe(true);
    expect(isProjectRole("OWNER")).toBe(false);
  });

  // THE KNOWN GAP, PINNED. Only ADMIN is discriminated anywhere in the product,
  // so an EDITOR and a VIEWER have identical effective permissions today. This
  // test does not endorse that; it records it, so that the day someone gives
  // EDITOR a capability VIEWER lacks, this test fails and forces the change to
  // be a deliberate product decision with a migration rather than a silent one.
  it("gives EDITOR and VIEWER identical effective permissions", () => {
    expect(isProjectAdmin(ProjectRole.EDITOR)).toBe(isProjectAdmin(ProjectRole.VIEWER));
    expect(isProjectAdmin(ProjectRole.EDITOR)).toBe(false);
    expect(isProjectAdmin(ProjectRole.ADMIN)).toBe(true);
  });

  it("treats an absent project membership as not an admin", () => {
    expect(isProjectAdmin(null)).toBe(false);
  });
});

describe("principal tier", () => {
  it("has the two schema values", () => {
    expect(PrincipalTier.OPERATOR).toBe("OPERATOR");
    expect(PrincipalTier.END_USER).toBe("END_USER");
  });
});
