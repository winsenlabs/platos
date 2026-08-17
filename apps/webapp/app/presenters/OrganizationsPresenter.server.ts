import type { PrismaClient } from "@platos/database";
import { redirect } from "remix-typedjson";
import { prisma } from "~/db.server";
import type { UserFromSession } from "~/services/session.server";
import { newOrganizationPath, newProjectPath } from "~/utils/pathBuilder";
import { SelectBestEnvironmentPresenter } from "./SelectBestEnvironmentPresenter.server";

export class OrganizationsPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call({
    user,
    organizationSlug,
    projectSlug,
    environmentId,
  }: {
    user: UserFromSession;
    organizationSlug: string;
    projectSlug?: string;
    environmentId?: string;
    request: Request;
  }) {
    const organizations = await this.#getOrganizations(user.id);
    if (organizations.length === 0) throw redirect(newOrganizationPath());
    const organization = organizations.find((item) => item.slug === organizationSlug);
    if (!organization) throw new Response("Organization not found", { status: 404 });

    const selector = new SelectBestEnvironmentPresenter(this.#prismaClient);
    const selectedProject = await selector.selectBestProjectFromProjects({
      user,
      projectSlug,
      projects: organization.projects,
    });
    if (!selectedProject) throw redirect(newProjectPath(organization));

    const project = await this.#prismaClient.project.findFirst({
      where: {
        id: selectedProject.id,
        organizationId: organization.id,
        archivedAt: null,
      },
      include: {
        environments: {
          where: { archivedAt: null },
          orderBy: [{ name: "asc" }, { id: "asc" }],
        },
      },
    });
    if (!project) throw new Response("Project not found", { status: 404 });
    const environment = environmentId
      ? project.environments.find((item) => item.id === environmentId)
      : await selector.selectBestEnvironment(project.id, user, project.environments);
    if (!environment) throw new Response("Environment not found in this project", { status: 404 });

    return {
      organizations,
      organization,
      project,
      environment,
      scopeState: "ready" as const,
    };
  }

  async #getOrganizations(userId: string) {
    const organizations = await this.#prismaClient.organization.findMany({
      where: {
        archivedAt: null,
        memberships: { some: { userId, deactivatedAt: null } },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        slug: true,
        name: true,
        projects: {
          where: { archivedAt: null },
          select: { id: true, slug: true, name: true, updatedAt: true },
          orderBy: { name: "asc" },
        },
        _count: {
          select: { memberships: { where: { deactivatedAt: null } } },
        },
      },
    });
    return organizations.map(({ _count, ...organization }) => ({
      ...organization,
      membersCount: _count.memberships,
    }));
  }
}
