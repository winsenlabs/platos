import { describe, expect, it } from "vitest";

import {
  AUTHORIZATION_SCOPE_KINDS,
  GLOBAL_SCOPE,
  assertAuthorizes,
  assertPermission,
  authorizes,
  hasPermission,
  scopeKindOf,
  tenantAuthorizationScope,
} from "./authorization-scope.js";
import {
  ENVIRONMENT,
  ORGANIZATION_ID,
  OTHER_ORGANIZATION_ID,
  PROJECT_ID,
  SIBLING_ENVIRONMENT,
} from "./testing.js";
import { environmentScope, organizationScope, projectScope } from "@platos/kernel";

const project = projectScope(ORGANIZATION_ID, PROJECT_ID);
const organization = organizationScope(ORGANIZATION_ID);
const foreignOrganization = organizationScope(OTHER_ORGANIZATION_ID);

describe("the scope kind is derived from the tenant node, never supplied", () => {
  it("names the four kinds the schema enum names", () => {
    expect([...AUTHORIZATION_SCOPE_KINDS]).toEqual([
      "GLOBAL",
      "ORGANIZATION",
      "PROJECT",
      "ENVIRONMENT",
    ]);
  });

  it("maps each tenant level to its kind", () => {
    expect(scopeKindOf(tenantAuthorizationScope(organization))).toBe("ORGANIZATION");
    expect(scopeKindOf(tenantAuthorizationScope(project))).toBe("PROJECT");
    expect(scopeKindOf(tenantAuthorizationScope(ENVIRONMENT))).toBe("ENVIRONMENT");
    expect(scopeKindOf(GLOBAL_SCOPE)).toBe("GLOBAL");
  });
});

describe("CROSS-SCOPE DENIAL", () => {
  const environmentGrant = tenantAuthorizationScope(ENVIRONMENT);

  it("DENIES A SIBLING ENVIRONMENT — the case an id comparison would let through", () => {
    expect(authorizes(environmentGrant, SIBLING_ENVIRONMENT)).toBe(false);
  });

  it("denies the parent project: a grant reaches down, never up", () => {
    expect(authorizes(environmentGrant, project)).toBe(false);
    expect(authorizes(environmentGrant, organization)).toBe(false);
  });

  it("denies another organization outright", () => {
    expect(authorizes(tenantAuthorizationScope(organization), foreignOrganization)).toBe(false);
    expect(
      authorizes(
        tenantAuthorizationScope(organization),
        environmentScope(OTHER_ORGANIZATION_ID, PROJECT_ID, ENVIRONMENT.environmentId),
      ),
    ).toBe(false);
  });

  it("allows a scope to reach itself and its own descendants", () => {
    expect(authorizes(environmentGrant, ENVIRONMENT)).toBe(true);
    expect(authorizes(tenantAuthorizationScope(project), ENVIRONMENT)).toBe(true);
    expect(authorizes(tenantAuthorizationScope(organization), ENVIRONMENT)).toBe(true);
  });

  it("lets GLOBAL reach everything — the platform-operator grant", () => {
    expect(authorizes(GLOBAL_SCOPE, ENVIRONMENT)).toBe(true);
    expect(authorizes(GLOBAL_SCOPE, foreignOrganization)).toBe(true);
  });

  it("reports a denial as FORBIDDEN_SCOPE naming the requested path", () => {
    const denied = assertAuthorizes(environmentGrant, SIBLING_ENVIRONMENT);
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe("FORBIDDEN_SCOPE");
    expect(denied.error.category).toBe("forbidden");
    expect(denied.error.message).toContain("env/env-2");
  });
});

describe("permissions are compared exactly, with one wildcard", () => {
  it("grants an exact match", () => {
    expect(hasPermission(["mcp:read", "mcp:write"], "mcp:write")).toBe(true);
  });

  it("grants everything under the wildcard", () => {
    expect(hasPermission(["*"], "anything:at:all")).toBe(true);
  });

  it("DOES NOT treat a namespace prefix as a glob", () => {
    expect(hasPermission(["mcp:*"], "mcp:write")).toBe(false);
  });

  it("refuses a missing permission as MISSING_PERMISSION, not FORBIDDEN_SCOPE", () => {
    const denied = assertPermission(["mcp:read"], "mcp:write");
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe("MISSING_PERMISSION");
  });

  it("denies against an empty grant rather than defaulting open", () => {
    expect(hasPermission([], "mcp:read")).toBe(false);
  });
});
