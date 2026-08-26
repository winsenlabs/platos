import { OrganizationRole, PlatosAuthError, ProjectRole } from "@platos/tenancy-database";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalOperatorScope } from "../../../tests/persisted-state-gate/fixture-contract";

const {
  changeMembershipRole,
  database,
  issueInvitation,
  requireOperator,
  transactionProjectCreate,
  transactionProjectMembershipCreate,
} = vi.hoisted(() => {
  const transactionProjectCreate = vi.fn();
  const transactionProjectMembershipCreate = vi.fn();
  return {
    changeMembershipRole: vi.fn(),
    database: {
      organizationMembership: { findFirst: vi.fn() },
      organization: { findFirst: vi.fn(), create: vi.fn() },
      project: { findFirst: vi.fn() },
      $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        project: { create: transactionProjectCreate },
        projectMembership: { create: transactionProjectMembershipCreate },
      })),
    },
    issueInvitation: vi.fn(),
    requireOperator: vi.fn(),
    transactionProjectCreate,
    transactionProjectMembershipCreate,
  };
});

vi.mock("~/services/auth.server", () => ({
  requireOperator,
  operatorAuth: { changeMembershipRole, issueInvitation },
}));
vi.mock("~/services/database.server", () => ({ database }));

import { loader as homeLoader } from "../app/routes/_app._index/route";
import { loader as organizationLoader } from "../app/routes/_app.orgs.$organizationSlug._index/route";
import { action as invitationAction } from "../app/routes/_app.orgs.$organizationSlug.invite/route";
import { loader as projectLoader } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam/route";
import {
  action as teamAction,
  loader as teamLoader,
} from "../app/routes/_app.orgs.$organizationSlug.settings.team/route";
import {
  action as newProjectAction,
  loader as newProjectLoader,
} from "../app/routes/_app.orgs.$organizationSlug_.projects.new/route";
import { action as newOrganizationAction } from "../app/routes/_app.orgs.new/route";

const primary = canonicalOperatorScope("alpha");
const secondary = canonicalOperatorScope("beta");
const databaseSecret = "SENTINEL_DATABASE_CONNECTION_DETAILS";
const authSecret = "SENTINEL_INVITATION_OR_SESSION_MATERIAL";
const organizationMembershipId = "organization-membership-alpha";
const targetMembershipId = "organization-membership-target";
const canonicalProjectVisibility = {
  archivedAt: null,
  OR: [
    {
      organization: {
        memberships: {
          some: {
            userId: primary.userId,
            deactivatedAt: null,
            role: { in: [OrganizationRole.OWNER, OrganizationRole.ADMIN] },
          },
        },
      },
    },
    {
      memberships: {
        some: {
          organizationMembership: { userId: primary.userId, deactivatedAt: null },
        },
      },
    },
  ],
};

function params() {
  return {
    organizationSlug: primary.organizationSlug,
    projectParam: primary.projectSlug,
  };
}

function loaderArgs(path: string, routeParams = params()): LoaderFunctionArgs {
  return {
    request: new Request(`https://dashboard.example${path}`),
    params: routeParams,
    context: {},
  };
}

function actionArgs(path: string, body: URLSearchParams, routeParams = params()): ActionFunctionArgs {
  return {
    request: new Request(`https://dashboard.example${path}`, { method: "POST", body }),
    params: routeParams,
    context: {},
  };
}

async function thrownResponse(operation: () => Promise<unknown>) {
  try {
    const result = await operation();
    if (result instanceof Response) return result;
    throw new Error("Expected route handler to return or throw a Response");
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperator.mockResolvedValue({
    userId: primary.userId,
    actorUserId: primary.userId,
    email: "operator@example.test",
    authorization: { role: "ADMIN", sessionMaterial: authSecret },
  });
  database.organizationMembership.findFirst.mockResolvedValue({
    id: organizationMembershipId,
    organizationId: primary.organizationId,
    organization: {
      id: primary.organizationId,
      slug: primary.organizationSlug,
      projects: [{
        id: primary.projectId,
        slug: primary.projectSlug,
        environments: [{ id: primary.environmentId, slug: primary.environmentSlug }],
      }],
    },
  });
  database.organization.findFirst.mockResolvedValue({
    id: primary.organizationId,
    name: "Alpha Organization",
    slug: primary.organizationSlug,
    projects: [{
      id: primary.projectId,
      name: "Alpha Project",
      slug: primary.projectSlug,
      environments: [{ id: primary.environmentId, name: "Production", slug: primary.environmentSlug }],
    }],
    memberships: [{
      id: targetMembershipId,
      role: OrganizationRole.MEMBER,
      user: { email: "member@example.test", displayName: "Member" },
    }],
  });
  database.project.findFirst.mockResolvedValue({
    id: primary.projectId,
    slug: primary.projectSlug,
    organization: { id: primary.organizationId, slug: primary.organizationSlug },
    environments: [{ id: primary.environmentId, slug: primary.environmentSlug }],
  });
  database.organization.create.mockResolvedValue({ id: primary.organizationId, slug: primary.organizationSlug });
  issueInvitation.mockResolvedValue({ invitationId: "invitation-safe-id", token: authSecret });
  changeMembershipRole.mockResolvedValue(undefined);
  transactionProjectCreate.mockResolvedValue({
    id: primary.projectId,
    slug: primary.projectSlug,
    environments: [{ slug: primary.environmentSlug }],
  });
  transactionProjectMembershipCreate.mockResolvedValue({ id: "project-membership-alpha" });
  database.$transaction.mockImplementation(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
    project: { create: transactionProjectCreate },
    projectMembership: { create: transactionProjectMembershipCreate },
  }));
});

describe("authenticated Organization and Project route evidence", () => {
  it.each([
    ["route-002", () => homeLoader(loaderArgs("/"))],
    ["route-004", () => organizationLoader(loaderArgs(`/orgs/${primary.organizationSlug}`))],
    ["route-005", () => invitationAction(actionArgs(`/orgs/${primary.organizationSlug}/invite`, new URLSearchParams({ email: "member@example.test" })))],
    ["route-006", () => projectLoader(loaderArgs(`/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}`))],
    ["route-073", () => teamLoader(loaderArgs(`/orgs/${primary.organizationSlug}/settings/team`))],
    ["route-074", () => newProjectLoader(loaderArgs(`/orgs/${primary.organizationSlug}/projects/new`))],
    ["route-075", () => newOrganizationAction(actionArgs("/orgs/new", new URLSearchParams({ name: "Alpha Organization" })))],
  ] as const)("%s rejects an unauthenticated operator before database or auth mutation", async (_routeId, operation) => {
    requireOperator.mockRejectedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: "/login" },
    }));

    const response = await thrownResponse(operation);

    expect(response.status).toBe(302);
    expect(database.organizationMembership.findFirst).not.toHaveBeenCalled();
    expect(database.organization.findFirst).not.toHaveBeenCalled();
    expect(database.project.findFirst).not.toHaveBeenCalled();
    expect(database.organization.create).not.toHaveBeenCalled();
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(issueInvitation).not.toHaveBeenCalled();
    expect(changeMembershipRole).not.toHaveBeenCalled();
  });

  it("route-002 resolves the first active persisted Organization, Project, and Environment ancestry", async () => {
    const response = await thrownResponse(() => homeLoader(loaderArgs("/")));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agents`,
    );
    expect(database.organizationMembership.findFirst).toHaveBeenCalledWith({
      where: {
        userId: primary.userId,
        deactivatedAt: null,
        organization: { archivedAt: null },
      },
      select: {
        organization: {
          select: {
            id: true,
            slug: true,
            projects: {
              where: canonicalProjectVisibility,
              orderBy: { createdAt: "asc" },
              take: 1,
              select: {
                id: true,
                slug: true,
                environments: {
                  where: { archivedAt: null },
                  orderBy: { createdAt: "asc" },
                  take: 1,
                  select: { id: true, slug: true },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
  });

  it("route-002 sends an operator with no complete active ancestry to Organization creation", async () => {
    database.organizationMembership.findFirst.mockResolvedValueOnce(null);
    const response = await thrownResponse(() => homeLoader(loaderArgs("/")));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/orgs/new");
  });

  it("route-004 returns only a membership-filtered Organization with active Projects and Environments", async () => {
    const response = await organizationLoader(loaderArgs(`/orgs/${primary.organizationSlug}`));
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(database.organization.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        slug: primary.organizationSlug,
        archivedAt: null,
        memberships: { some: { userId: primary.userId, deactivatedAt: null } },
      },
      select: expect.objectContaining({
        id: true,
        projects: expect.objectContaining({ where: canonicalProjectVisibility }),
      }),
    }));
    expect(serialized).toContain(primary.organizationId);
    expect(serialized).toContain(primary.projectId);
    expect(serialized).toContain(primary.environmentId);
    expect(serialized).not.toContain(authSecret);
  });

  it("route-004 hides a foreign Organization behind a stable 404", async () => {
    database.organization.findFirst.mockResolvedValueOnce(null);
    const response = await thrownResponse(() => organizationLoader(loaderArgs(
      `/orgs/${secondary.organizationSlug}`,
      { ...params(), organizationSlug: secondary.organizationSlug },
    )));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("route-005 requires OWNER or ADMIN membership and issues a normalized MEMBER invitation", async () => {
    database.organization.findFirst.mockResolvedValueOnce({ id: primary.organizationId });
    const response = await invitationAction(actionArgs(
      `/orgs/${primary.organizationSlug}/invite`,
      new URLSearchParams({ email: "  MEMBER@Example.Test " }),
    ));
    const serialized = JSON.stringify(await response.json());

    expect(database.organization.findFirst).toHaveBeenCalledWith({
      where: {
        slug: primary.organizationSlug,
        memberships: {
          some: {
            userId: primary.userId,
            deactivatedAt: null,
            role: { in: [OrganizationRole.OWNER, OrganizationRole.ADMIN] },
          },
        },
      },
      select: { id: true },
    });
    expect(issueInvitation).toHaveBeenCalledWith({
      organizationId: primary.organizationId,
      inviterId: primary.userId,
      email: "member@example.test",
      role: OrganizationRole.MEMBER,
    });
    expect(serialized).toBe(JSON.stringify({ ok: true, invitationId: "invitation-safe-id" }));
    expect(serialized).not.toContain(authSecret);
  });

  it("route-005 rejects foreign or under-privileged membership before invitation issuance", async () => {
    database.organization.findFirst.mockResolvedValueOnce(null);
    const response = await thrownResponse(() => invitationAction(actionArgs(
      `/orgs/${secondary.organizationSlug}/invite`,
      new URLSearchParams({ email: "member@example.test" }),
      { ...params(), organizationSlug: secondary.organizationSlug },
    )));
    expect(response.status).toBe(403);
    expect(issueInvitation).not.toHaveBeenCalled();
  });

  it("route-005 rejects a malformed invitation form before auth mutation", async () => {
    database.organization.findFirst.mockResolvedValueOnce({ id: primary.organizationId });
    const response = await thrownResponse(() => invitationAction(actionArgs(
      `/orgs/${primary.organizationSlug}/invite`,
      new URLSearchParams({ email: "not-an-email" }),
    )));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Valid email is required");
    expect(issueInvitation).not.toHaveBeenCalled();
  });

  it("route-006 resolves an active membership-filtered Project to its first active Environment", async () => {
    const response = await thrownResponse(() => projectLoader(loaderArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}`,
    )));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agents`,
    );
    expect(database.project.findFirst).toHaveBeenCalledWith({
      where: {
        slug: primary.projectSlug,
        ...canonicalProjectVisibility,
        organization: {
          slug: primary.organizationSlug,
          archivedAt: null,
        },
      },
      select: {
        id: true,
        slug: true,
        organization: { select: { id: true, slug: true } },
        environments: {
          where: { archivedAt: null },
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { id: true, slug: true },
        },
      },
    });
  });

  it("prevents a same-Organization MEMBER from enumerating a Project or Environment without ProjectMembership", async () => {
    requireOperator.mockResolvedValue({
      userId: primary.userId,
      actorUserId: primary.userId,
      email: "member@example.test",
      authorization: { role: OrganizationRole.MEMBER, sessionMaterial: authSecret },
    });
    const allowedProject = {
      id: primary.projectId,
      name: "Allowed Project",
      slug: primary.projectSlug,
      environments: [{ id: primary.environmentId, name: "Production", slug: primary.environmentSlug }],
    };
    const restrictedProject = {
      id: secondary.projectId,
      name: "Restricted Project",
      slug: secondary.projectSlug,
      environments: [{ id: secondary.environmentId, name: "Restricted", slug: secondary.environmentSlug }],
    };
    const hasCanonicalVisibility = (where: unknown) =>
      JSON.stringify(where) === JSON.stringify(canonicalProjectVisibility);

    database.organizationMembership.findFirst.mockImplementationOnce(async ({ select }: any) =>
      ({
        organization: {
          id: primary.organizationId,
          slug: primary.organizationSlug,
          projects: hasCanonicalVisibility(select.organization.select.projects.where)
            ? [allowedProject]
            : [restrictedProject],
        },
      }),
    );
    const home = await thrownResponse(() => homeLoader(loaderArgs("/")));
    expect(home.status).toBe(302);
    expect(home.headers.get("Location")).toContain(primary.projectSlug);
    expect(home.headers.get("Location")).not.toContain(secondary.projectSlug);

    database.organization.findFirst.mockImplementationOnce(async ({ select }: any) =>
      ({
        id: primary.organizationId,
        name: "Alpha Organization",
        slug: primary.organizationSlug,
        projects: hasCanonicalVisibility(select.projects.where)
          ? [allowedProject]
          : [allowedProject, restrictedProject],
      }),
    );
    const organization = await organizationLoader(loaderArgs(`/orgs/${primary.organizationSlug}`));
    const serialized = JSON.stringify(await organization.json());
    expect(serialized).toContain(primary.projectId);
    expect(serialized).not.toContain(secondary.projectId);
    expect(serialized).not.toContain(secondary.environmentId);

    database.project.findFirst.mockImplementationOnce(async ({ where }: any) =>
      JSON.stringify(where) === JSON.stringify({
        slug: secondary.projectSlug,
        ...canonicalProjectVisibility,
        organization: { slug: primary.organizationSlug, archivedAt: null },
      })
        ? null
        : {
            ...restrictedProject,
            organization: { id: primary.organizationId, slug: primary.organizationSlug },
          },
    );
    const project = await thrownResponse(() => projectLoader(loaderArgs(
      `/orgs/${primary.organizationSlug}/projects/${secondary.projectSlug}`,
      { ...params(), projectParam: secondary.projectSlug },
    )));
    expect(project.status).toBe(404);
    expect(await project.text()).toBe("Project not found");
  });

  it("route-006 hides a foreign Project and does not authorize nested child paths twice", async () => {
    database.project.findFirst.mockResolvedValueOnce(null);
    const foreign = await thrownResponse(() => projectLoader(loaderArgs(
      `/orgs/${primary.organizationSlug}/projects/${secondary.projectSlug}`,
      { ...params(), projectParam: secondary.projectSlug },
    )));
    expect(foreign.status).toBe(404);

    vi.clearAllMocks();
    const nested = await projectLoader(loaderArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agents`,
    ));
    expect(nested).toBeNull();
    expect(requireOperator).not.toHaveBeenCalled();
    expect(database.project.findFirst).not.toHaveBeenCalled();
  });

  it("route-073 loads members only through an OWNER or ADMIN Organization gate", async () => {
    database.organization.findFirst.mockResolvedValueOnce({
      id: primary.organizationId,
      name: "Alpha Organization",
      memberships: [{
        id: targetMembershipId,
        role: OrganizationRole.MEMBER,
        user: { email: "member@example.test", displayName: "Member" },
      }],
    });
    const response = await teamLoader(loaderArgs(`/orgs/${primary.organizationSlug}/settings/team`));
    const serialized = JSON.stringify(await response.json());

    expect(database.organization.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        slug: primary.organizationSlug,
        memberships: { some: {
          userId: primary.userId,
          deactivatedAt: null,
          role: { in: [OrganizationRole.OWNER, OrganizationRole.ADMIN] },
        } },
      }),
    }));
    expect(serialized).toContain("member@example.test");
    expect(serialized).not.toContain(authSecret);
  });

  it("route-073 validates and applies an Organization membership role form", async () => {
    database.organization.findFirst.mockResolvedValueOnce({ id: primary.organizationId, name: "Alpha", memberships: [] });
    const response = await teamAction(actionArgs(
      `/orgs/${primary.organizationSlug}/settings/team`,
      new URLSearchParams({ membershipId: targetMembershipId, role: OrganizationRole.ADMIN }),
    ));

    expect(response.status).toBe(200);
    expect(changeMembershipRole).toHaveBeenCalledWith({
      organizationId: primary.organizationId,
      membershipId: targetMembershipId,
      actorUserId: primary.userId,
      role: OrganizationRole.ADMIN,
    });
  });

  it.each([
    ["missing membership", { role: OrganizationRole.ADMIN }, "Membership is required"],
    ["invalid role", { membershipId: targetMembershipId, role: "ROOT" }, "Invalid role"],
  ])("route-073 rejects a %s form before role mutation", async (_case, values, message) => {
    database.organization.findFirst.mockResolvedValueOnce({ id: primary.organizationId, name: "Alpha", memberships: [] });
    const response = await thrownResponse(() => teamAction(actionArgs(
      `/orgs/${primary.organizationSlug}/settings/team`,
      new URLSearchParams(values),
    )));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(message);
    expect(changeMembershipRole).not.toHaveBeenCalled();
  });

  it("route-074 creates a Project, first Environment, and ADMIN membership in transaction order", async () => {
    database.organizationMembership.findFirst.mockResolvedValueOnce({
      id: organizationMembershipId,
      organizationId: primary.organizationId,
    });
    const response = await thrownResponse(() => newProjectAction(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/new`,
      new URLSearchParams({ name: "Alpha Project", environment: "Production" }),
    )));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agents`,
    );
    expect(database.organizationMembership.findFirst).toHaveBeenCalledWith({
      where: {
        userId: primary.userId,
        deactivatedAt: null,
        organization: { slug: primary.organizationSlug, archivedAt: null },
      },
      select: { id: true, organizationId: true },
    });
    expect(transactionProjectCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        organizationId: primary.organizationId,
        name: "Alpha Project",
        slug: "alpha-project",
        environments: { create: { name: "Production", slug: "production" } },
      },
    }));
    expect(transactionProjectMembershipCreate).toHaveBeenCalledWith({
      data: {
        projectId: primary.projectId,
        organizationMembershipId,
        organizationId: primary.organizationId,
        role: ProjectRole.ADMIN,
      },
    });
    expect(transactionProjectCreate.mock.invocationCallOrder[0]).toBeLessThan(
      transactionProjectMembershipCreate.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ["empty Project name", { name: "", environment: "Production" }, "Project name and slug are required"],
    ["empty Environment name", { name: "Alpha", environment: "" }, "Environment name is required"],
    ["invalid explicit slug", { name: "Alpha", slug: "!!!", environment: "Production" }, "Project name and slug are required"],
  ])("route-074 rejects %s before opening a transaction", async (_case, values, message) => {
    database.organizationMembership.findFirst.mockResolvedValueOnce({
      id: organizationMembershipId,
      organizationId: primary.organizationId,
    });
    const response = await thrownResponse(() => newProjectAction(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/new`,
      new URLSearchParams(values),
    )));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(message);
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("route-074 rejects a foreign Organization membership before creating state", async () => {
    database.organizationMembership.findFirst.mockResolvedValueOnce(null);
    const response = await thrownResponse(() => newProjectAction(actionArgs(
      `/orgs/${secondary.organizationSlug}/projects/new`,
      new URLSearchParams({ name: "Foreign", environment: "Production" }),
      { ...params(), organizationSlug: secondary.organizationSlug },
    )));
    expect(response.status).toBe(403);
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("route-075 creates an Organization with an OWNER membership for the authenticated operator", async () => {
    const response = await thrownResponse(() => newOrganizationAction(actionArgs(
      "/orgs/new",
      new URLSearchParams({ name: "Alpha Organization" }),
    )));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`/orgs/${primary.organizationSlug}/projects/new`);
    expect(database.organization.create).toHaveBeenCalledWith({
      data: {
        name: "Alpha Organization",
        slug: "alpha-organization",
        memberships: { create: { userId: primary.userId, role: OrganizationRole.OWNER } },
      },
    });
  });

  it.each([
    ["route-002", () => homeLoader(loaderArgs("/")), () => database.organizationMembership.findFirst.mockRejectedValueOnce(new Error(databaseSecret)), "Organizations unavailable"],
    ["route-004", () => organizationLoader(loaderArgs(`/orgs/${primary.organizationSlug}`)), () => database.organization.findFirst.mockRejectedValueOnce(new Error(databaseSecret)), "Organization unavailable"],
    ["route-005 database", () => invitationAction(actionArgs(`/orgs/${primary.organizationSlug}/invite`, new URLSearchParams({ email: "member@example.test" }))), () => database.organization.findFirst.mockRejectedValueOnce(new Error(databaseSecret)), "Invitation service is unavailable"],
    ["route-005 auth", () => invitationAction(actionArgs(`/orgs/${primary.organizationSlug}/invite`, new URLSearchParams({ email: "member@example.test" }))), () => {
      database.organization.findFirst.mockResolvedValueOnce({ id: primary.organizationId });
      issueInvitation.mockRejectedValueOnce(new Error(authSecret));
    }, "Invitation service is unavailable"],
    ["route-006", () => projectLoader(loaderArgs(`/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}`)), () => database.project.findFirst.mockRejectedValueOnce(new Error(databaseSecret)), "Project unavailable"],
    ["route-073 database", () => teamLoader(loaderArgs(`/orgs/${primary.organizationSlug}/settings/team`)), () => database.organization.findFirst.mockRejectedValueOnce(new Error(databaseSecret)), "Team unavailable"],
    ["route-073 auth", () => teamAction(actionArgs(`/orgs/${primary.organizationSlug}/settings/team`, new URLSearchParams({ membershipId: targetMembershipId, role: OrganizationRole.ADMIN }))), () => {
      database.organization.findFirst.mockResolvedValueOnce({ id: primary.organizationId, name: "Alpha", memberships: [] });
      changeMembershipRole.mockRejectedValueOnce(new PlatosAuthError("forbidden", 403, authSecret));
    }, "Membership update failed"],
    ["route-074 membership", () => newProjectLoader(loaderArgs(`/orgs/${primary.organizationSlug}/projects/new`)), () => database.organizationMembership.findFirst.mockRejectedValueOnce(new Error(databaseSecret)), "Project creation unavailable"],
    ["route-074 transaction", () => newProjectAction(actionArgs(`/orgs/${primary.organizationSlug}/projects/new`, new URLSearchParams({ name: "Alpha Project", environment: "Production" }))), () => {
      database.organizationMembership.findFirst.mockResolvedValueOnce({ id: organizationMembershipId, organizationId: primary.organizationId });
      database.$transaction.mockRejectedValueOnce(new Error(databaseSecret));
    }, "Project creation failed"],
    ["route-075", () => newOrganizationAction(actionArgs("/orgs/new", new URLSearchParams({ name: "Alpha Organization" }))), () => database.organization.create.mockRejectedValueOnce(new Error(databaseSecret)), "Organization creation failed"],
  ] as const)("%s serializes a stable failure without database, invitation, or session details", async (_case, operation, fail, stableMessage) => {
    fail();
    const response = await thrownResponse(operation);
    const serialized = await response.text();

    expect(response.status).toBeGreaterThanOrEqual(403);
    expect(serialized).toBe(stableMessage);
    expect(serialized).not.toContain(databaseSecret);
    expect(serialized).not.toContain(authSecret);
  });
});
