import type { Environment, OperatorAuthorization, Prisma } from "@platos/database";
import { $replica, prisma } from "~/db.server";

export type { Environment } from "@platos/database";

const environmentScopeInclude = {
  project: {
    include: {
      organization: true,
    },
  },
} satisfies Prisma.EnvironmentInclude;

export async function findEnvironmentById(id: string, userId?: string, projectId?: string) {
  return $replica.environment.findFirst({
    where: {
      id,
      ...(projectId ? { projectId } : {}),
      archivedAt: null,
      project: {
        archivedAt: null,
        organization: {
          archivedAt: null,
          ...(userId
            ? { memberships: { some: { userId, deactivatedAt: null } } }
            : {}),
        },
      },
    },
    include: environmentScopeInclude,
  });
}

export type DisplayableInputEnvironment = Pick<Environment, "id" | "name" | "slug" | "archivedAt">;

export function displayableEnvironment(environment: DisplayableInputEnvironment) {
  return {
    id: environment.id,
    name: environment.name,
    slug: environment.slug,
    archivedAt: environment.archivedAt,
  };
}

export async function findDisplayableEnvironment(environmentId: string, userId?: string) {
  const environment = await findEnvironmentById(environmentId, userId);
  return environment ? displayableEnvironment(environment) : undefined;
}

export async function hasAccessToEnvironment({
  environmentId,
  projectId,
  organizationId,
  userId,
}: {
  environmentId: string;
  projectId: string;
  organizationId: string;
  userId: string;
}): Promise<boolean> {
  const environment = await $replica.environment.findFirst({
    where: {
      id: environmentId,
      projectId,
      archivedAt: null,
      project: {
        organizationId,
        archivedAt: null,
        organization: {
          archivedAt: null,
          memberships: { some: { userId, deactivatedAt: null } },
        },
      },
    },
    select: { id: true },
  });
  return environment !== null;
}

export async function createEnvironmentSession(
  environment: Pick<Environment, "id">,
  operator: Pick<OperatorAuthorization, "sessionId">
) {
  return prisma.environmentSession.create({
    data: {
      environmentId: environment.id,
      operatorSessionId: operator.sessionId,
    },
  });
}
