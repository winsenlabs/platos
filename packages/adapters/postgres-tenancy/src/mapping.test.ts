// Row -> record mapping, and the three refusals that keep an unreadable column
// from becoming an authorization decision.
//
// THE ENUM CASES ARE THE POINT. A role column is the input to
// `isOrganizationAdmin`, so a row holding a value this binary has not heard of
// is not a display problem — it is a value that would be compared against
// "OWNER", found unequal, and quietly treated as least privilege, or (with a
// cast) treated as whatever the string happened to be. The expand/contract
// window in this issue's acceptance is exactly when such a row exists: a newer
// binary writes a value an older one cannot read. Refusing loudly, with a code
// per column, is what makes that visible in an operator's log.

import { describe, expect, test } from "vitest";

import {
  readOrganizationRole,
  readPrincipalTier,
  readProjectRole,
  toEntity,
  toEnvironment,
  toEnvironmentSession,
  toInvitation,
  toOrganization,
  toOrganizationMembership,
  toProject,
  toProjectMembership,
  UNKNOWN_ORGANIZATION_ROLE,
  UNKNOWN_PRINCIPAL_TIER,
  UNKNOWN_PROJECT_ROLE,
  UnreadableRowError,
} from "./mapping.js";

const CREATED = new Date("2026-03-01T10:00:00.000Z");
const UPDATED = new Date("2026-03-02T10:00:00.000Z");

describe("enum columns are validated, not cast", () => {
  test("reads the three organization roles the domain declares", () => {
    expect(readOrganizationRole("OWNER")).toBe("OWNER");
    expect(readOrganizationRole("ADMIN")).toBe("ADMIN");
    expect(readOrganizationRole("MEMBER")).toBe("MEMBER");
  });

  test("refuses an unknown organization role with its own code", () => {
    expect(() => readOrganizationRole("SUPERUSER")).toThrowError(
      expect.objectContaining({
        name: "UnreadableRowError",
        code: UNKNOWN_ORGANIZATION_ROLE,
        column: "OrganizationMembership.role",
        value: "SUPERUSER",
      }),
    );
  });

  test("refuses a project role that is only an organization role", () => {
    expect(() => readProjectRole("OWNER")).toThrowError(
      expect.objectContaining({ code: UNKNOWN_PROJECT_ROLE }),
    );
    expect(readProjectRole("ADMIN")).toBe("ADMIN");
  });

  test("refuses an unknown principal tier with its own code", () => {
    expect(readPrincipalTier("OPERATOR")).toBe("OPERATOR");
    expect(readPrincipalTier("END_USER")).toBe("END_USER");
    expect(() => readPrincipalTier("SERVICE")).toThrowError(
      expect.objectContaining({ code: UNKNOWN_PRINCIPAL_TIER }),
    );
  });

  test("the three codes are pairwise distinct", () => {
    const codes = [UNKNOWN_ORGANIZATION_ROLE, UNKNOWN_PROJECT_ROLE, UNKNOWN_PRINCIPAL_TIER];
    expect(new Set(codes).size).toBe(3);
  });

  test("UnreadableRowError carries the column and the value as data", () => {
    const error = new UnreadableRowError(UNKNOWN_PROJECT_ROLE, "ProjectMembership.role", "GOD");
    expect(error).toBeInstanceOf(Error);
    expect(error.column).toBe("ProjectMembership.role");
    expect(error.value).toBe("GOD");
  });
});

describe("row -> record", () => {
  test("an organization keeps every column and invents none", () => {
    expect(
      toOrganization({
        id: "org-1",
        slug: "acme",
        name: "Acme",
        archivedAt: null,
        createdAt: CREATED,
        updatedAt: UPDATED,
      }),
    ).toEqual({
      id: "org-1",
      slug: "acme",
      name: "Acme",
      archivedAt: null,
      createdAt: CREATED,
      updatedAt: UPDATED,
    });
  });

  test("a project carries the organization it hangs off", () => {
    const project = toProject({
      id: "proj-1",
      organizationId: "org-1",
      slug: "web",
      name: "Web",
      archivedAt: UPDATED,
      createdAt: CREATED,
      updatedAt: UPDATED,
    });
    expect(project.organizationId).toBe("org-1");
    expect(project.archivedAt).toEqual(UPDATED);
  });

  test("an environment carries its revocation generation and both backfill columns", () => {
    const environment = toEnvironment({
      id: "env-1",
      projectId: "proj-1",
      slug: "prod",
      name: "Production",
      archivedAt: null,
      accessKeyRevocationVersion: 7,
      memoryFeedbackBackfillCursor: "cursor-9",
      memoryFeedbackBackfillCompletedAt: UPDATED,
      createdAt: CREATED,
      updatedAt: UPDATED,
    });
    expect(environment.accessKeyRevocationVersion).toBe(7);
    expect(environment.memoryFeedbackBackfillCursor).toBe("cursor-9");
    expect(environment.memoryFeedbackBackfillCompletedAt).toEqual(UPDATED);
  });

  test("a membership keeps a null deactivatedAt as null", () => {
    const membership = toOrganizationMembership({
      id: "mem-1",
      organizationId: "org-1",
      userId: "user-1",
      role: "ADMIN",
      deactivatedAt: null,
      createdAt: CREATED,
      updatedAt: UPDATED,
    });
    expect(membership.deactivatedAt).toBeNull();
    expect(membership.role).toBe("ADMIN");
  });

  test("a project membership keeps the integrity key the schema derives", () => {
    const membership = toProjectMembership({
      id: "pm-1",
      projectId: "proj-1",
      organizationMembershipId: "mem-1",
      organizationId: "org-1",
      role: "EDITOR",
      createdAt: CREATED,
      updatedAt: UPDATED,
    });
    expect(membership.organizationId).toBe("org-1");
  });

  test("an invitation renames tokenHash to the domain's tokenDigest and keeps nulls", () => {
    const invitation = toInvitation({
      id: "inv-1",
      organizationId: "org-1",
      inviterId: null,
      acceptedByUserId: null,
      email: "person@example.test",
      role: "MEMBER",
      tokenHash: "digest-1",
      expiresAt: UPDATED,
      acceptedAt: null,
      revokedAt: null,
      createdAt: CREATED,
    });
    expect(invitation.tokenDigest).toBe("digest-1");
    expect(invitation.inviterId).toBeNull();
    expect(invitation.acceptedByUserId).toBeNull();
  });

  test("an entity copies its three string arrays rather than aliasing the row", () => {
    const mcpUrls = ["https://one.example.test"];
    const entity = toEntity({
      id: "ent-1",
      projectId: "proj-1",
      externalId: "external-1",
      displayName: "Entity",
      connectionStatus: "CONNECTED",
      connectionKind: "MCP",
      mcpUrls,
      allowedOrigins: [],
      capabilities: ["tools"],
      lastConnectedAt: null,
      createdAt: CREATED,
      updatedAt: UPDATED,
    });
    expect(entity.mcpUrls).toEqual(mcpUrls);
    expect(entity.mcpUrls).not.toBe(mcpUrls);
  });

  test("an environment session validates its tier on the way through", () => {
    const session = toEnvironmentSession({
      id: "sess-1",
      environmentId: "env-1",
      operatorSessionId: "op-1",
      tier: "OPERATOR",
      ipAddress: null,
      userAgent: null,
      lastSeenAt: null,
      endedAt: null,
      createdAt: CREATED,
    });
    expect(session.tier).toBe("OPERATOR");
    expect(() =>
      toEnvironmentSession({
        id: "sess-2",
        environmentId: "env-1",
        operatorSessionId: "op-1",
        tier: "ROBOT",
        ipAddress: null,
        userAgent: null,
        lastSeenAt: null,
        endedAt: null,
        createdAt: CREATED,
      }),
    ).toThrowError(expect.objectContaining({ code: UNKNOWN_PRINCIPAL_TIER }));
  });
});
