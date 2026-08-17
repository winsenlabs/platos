import type { Environment, PrismaClient, Project } from "@platos/database";
import { prisma } from "~/db.server";
import type { UserFromSession } from "~/services/session.server";

export type MinimumEnvironment = Pick<Environment, "id" | "name" | "slug" | "archivedAt">;

export class SelectBestEnvironmentPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call({ user }: { user: UserFromSession }) {
    const project = await this.getBestProject(user);
    const environment = await this.selectBestEnvironment(project.id, user, project.environments);
    return { project, organization: project.organization, environment };
  }

  async getBestProject(user: UserFromSession) {
    const currentProjectId = user.dashboardPreferences.currentProjectId;
    const where = {
      archivedAt: null,
      organization: {
        archivedAt: null,
        memberships: { some: { userId: user.id, deactivatedAt: null } },
      },
    } as const;
    const include = {
      organization: true,
      environments: { where: { archivedAt: null }, orderBy: { name: "asc" as const } },
    };
    if (currentProjectId) {
      const current = await this.#prismaClient.project.findFirst({
        where: { ...where, id: currentProjectId },
        include,
      });
      if (current) return current;
    }
    const project = await this.#prismaClient.project.findFirst({
      where,
      include,
      orderBy: { updatedAt: "desc" },
    });
    if (!project) throw new Response("No accessible project", { status: 404 });
    return project;
  }

  async selectBestProjectFromProjects<T extends Pick<Project, "id" | "slug" | "updatedAt">>({
    user,
    projectSlug,
    projects,
  }: {
    user: UserFromSession;
    projectSlug?: string;
    projects: T[];
  }): Promise<T | undefined> {
    if (projectSlug) {
      const requested = projects.find((project) => project.slug === projectSlug);
      if (requested) return requested;
    }
    const currentProjectId = user.dashboardPreferences.currentProjectId;
    return (
      projects.find((project) => project.id === currentProjectId) ??
      [...projects].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]
    );
  }

  async selectBestEnvironment<T extends MinimumEnvironment>(
    projectId: string,
    user: UserFromSession,
    environments: T[]
  ): Promise<T> {
    const currentEnvironmentId =
      user.dashboardPreferences.projects[projectId]?.currentEnvironment.id;
    const selected =
      environments.find((environment) => environment.id === currentEnvironmentId) ??
      [...environments].sort((a, b) => a.name.localeCompare(b.name))[0];
    if (!selected) throw new Response("Project has no active environments", { status: 404 });
    return selected;
  }
}
