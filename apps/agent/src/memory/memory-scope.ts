import type { ControlDatabaseClient } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";

export type MemoryScope = Pick<
  RequestScope,
  "organizationId" | "projectId" | "environmentId"
> & { agentId?: string | null };

export interface ResolvedEndUser {
  id: string;
  externalId: string;
}

export interface ResolvedAgentBinding {
  agentId: string;
  clusterId: string | null;
}

const UUID_OR_URN_UUID = /^(?:urn:uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MemoryEndUserContextError extends Error {
  readonly code = "MEMORY_END_USER_CONTEXT_REQUIRED";

  constructor() {
    super("Memory end user not found or access denied");
    this.name = "MemoryEndUserContextError";
  }
}

export function environmentScopeWhere(scope: MemoryScope) {
  return {
    environmentId: scope.environmentId,
    environment: {
      projectId: scope.projectId,
      project: { organizationId: scope.organizationId },
    },
  } as const;
}

export async function assertEnvironmentScope(
  prisma: ControlDatabaseClient,
  scope: MemoryScope,
): Promise<void> {
  if (!scope?.organizationId || !scope?.projectId || !scope?.environmentId) {
    throw new Error("Memory scope tuple is required");
  }
  const environment = await prisma.environment.findFirst({
    where: {
      id: scope.environmentId,
      projectId: scope.projectId,
      project: { organizationId: scope.organizationId },
    },
    select: { id: true },
  });
  if (!environment) throw new Error("Memory scope not found or access denied");
}

export async function resolveEndUser(
  prisma: ControlDatabaseClient,
  scope: MemoryScope,
  userId: string,
): Promise<ResolvedEndUser> {
  if (!userId) throw new Error("Memory end user is required");

  // EndUser.id is UUID-backed, while verified external identity subjects are
  // intentionally opaque and may be arbitrary strings. Do not pass an
  // external subject to the UUID column before resolving identity.
  if (UUID_OR_URN_UUID.test(userId)) {
    const direct = await prisma.endUser.findFirst({
      where: { id: userId, organizationId: scope.organizationId, disabledAt: null },
      select: {
        id: true,
        identities: {
          where: {
            issuer: "platos:external",
            channel: "external",
            disabledAt: null,
            verifiedAt: { not: null },
          },
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { subject: true },
        },
      },
    });
    if (direct) {
      return { id: direct.id, externalId: direct.identities[0]?.subject ?? direct.id };
    }
  }

  const externalIdentity = await prisma.endUserIdentity.findFirst({
    where: {
      organizationId: scope.organizationId,
      issuer: "platos:external",
      channel: "external",
      subject: userId,
      disabledAt: null,
      verifiedAt: { not: null },
      endUser: { disabledAt: null },
    },
    select: { endUserId: true, subject: true },
  });
  if (externalIdentity) {
    return { id: externalIdentity.endUserId, externalId: externalIdentity.subject };
  }

  const identity = await prisma.endUserIdentity.findFirst({
    where: {
      organizationId: scope.organizationId,
      subject: userId,
      disabledAt: null,
      endUser: { disabledAt: null },
    },
    orderBy: { createdAt: "asc" },
    select: { endUserId: true, subject: true },
  });
  if (!identity) throw new MemoryEndUserContextError();
  return { id: identity.endUserId, externalId: identity.subject };
}

export async function resolveOperatorSelectedEndUser(
  prisma: ControlDatabaseClient,
  scope: MemoryScope,
  endUserId: string,
): Promise<ResolvedEndUser> {
  if (!endUserId) throw new MemoryEndUserContextError();
  await assertEnvironmentScope(prisma, scope);

  const endUser = await prisma.endUser.findFirst({
    where: {
      id: endUserId,
      organizationId: scope.organizationId,
      disabledAt: null,
    },
    select: {
      id: true,
      identities: {
        where: {
          issuer: "platos:external",
          channel: "external",
          disabledAt: null,
          verifiedAt: { not: null },
        },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { subject: true },
      },
    },
  });
  if (!endUser) throw new MemoryEndUserContextError();
  return { id: endUser.id, externalId: endUser.identities[0]?.subject ?? endUser.id };
}

export async function resolveAgentBinding(
  prisma: ControlDatabaseClient,
  scope: MemoryScope,
  agentId: string,
): Promise<ResolvedAgentBinding> {
  if (!agentId) throw new Error("Memory persistence requires an Agent");
  const binding = await prisma.agentBinding.findFirst({
    where: {
      agentId,
      ...environmentScopeWhere(scope),
      agent: { projectId: scope.projectId },
    },
    select: { agentId: true, clusterId: true },
  });
  if (!binding) throw new Error("Memory Agent not found or access denied");
  return binding;
}

export async function resolveWriteBinding(
  prisma: ControlDatabaseClient,
  scope: MemoryScope,
  requestedAgentId?: string | null,
  sourceThreadId?: string | null,
): Promise<ResolvedAgentBinding> {
  const actingAgentId = scope.agentId || null;
  if (actingAgentId) {
    const acting = await resolveAgentBinding(prisma, scope, actingAgentId);
    if (!requestedAgentId || requestedAgentId === actingAgentId) return acting;

    const requested = await resolveAgentBinding(prisma, scope, requestedAgentId);
    if (!canShareAgentScope(acting, requested)) {
      throw new Error("Memory write Agent is outside the acting AgentCluster");
    }
    return requested;
  }

  if (requestedAgentId) return resolveAgentBinding(prisma, scope, requestedAgentId);

  if (sourceThreadId) {
    const thread = await prisma.thread.findFirst({
      where: { id: sourceThreadId, ...environmentScopeWhere(scope) },
      select: { agentId: true, clusterId: true },
    });
    if (!thread) throw new Error("Memory source thread not found or access denied");
    return { agentId: thread.agentId, clusterId: thread.clusterId };
  }

  const bindings = await prisma.agentBinding.findMany({
    where: environmentScopeWhere(scope),
    select: { agentId: true, clusterId: true },
    take: 2,
  });
  if (bindings.length !== 1) {
    throw new Error("Memory persistence requires an explicit Agent in multi-Agent environments");
  }
  return bindings[0]!;
}

export async function resolveReadAgentIds(
  prisma: ControlDatabaseClient,
  scope: MemoryScope,
  requestedAgentId?: string | null,
  requestedAgentIds?: string[],
): Promise<string[]> {
  return (await resolveReadAgentBindings(
    prisma,
    scope,
    requestedAgentId,
    requestedAgentIds,
  )).map(({ agentId }) => agentId);
}

export async function resolveReadAgentBindings(
  prisma: ControlDatabaseClient,
  scope: MemoryScope,
  requestedAgentId?: string | null,
  requestedAgentIds?: string[],
): Promise<ResolvedAgentBinding[]> {
  const actingAgentId = scope.agentId || null;
  const requested = Array.from(
    new Set(
      (requestedAgentIds?.length ? requestedAgentIds : requestedAgentId ? [requestedAgentId] : scope.agentId ? [scope.agentId] : [])
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  const targetIds = requested.length
    ? requested
    : actingAgentId
      ? [actingAgentId]
      : [];
  if (targetIds.length === 0) {
    const persisted = await prisma.agentBinding.findMany({
      where: {
        ...environmentScopeWhere(scope),
        agent: { projectId: scope.projectId },
      },
      select: { agentId: true, clusterId: true },
    });
    if (persisted.length === 1) return persisted;
    const clusterId = persisted[0]?.clusterId;
    if (
      persisted.length > 1 &&
      clusterId &&
      persisted.every((binding) => binding.clusterId === clusterId)
    ) {
      return persisted;
    }
    throw new Error("Memory reads require one persisted Agent or AgentCluster scope");
  }

  const bindingIds = Array.from(new Set([
    ...(actingAgentId ? [actingAgentId] : []),
    ...targetIds,
  ]));

  const bindings = await prisma.agentBinding.findMany({
    where: {
      ...environmentScopeWhere(scope),
      agentId: { in: bindingIds },
      agent: { projectId: scope.projectId },
    },
    select: { agentId: true, clusterId: true },
  });
  if (bindings.length !== bindingIds.length) {
    throw new Error("Memory Agent scope not found or access denied");
  }

  if (actingAgentId) {
    const acting = bindings.find((binding) => binding.agentId === actingAgentId)!;
    if (targetIds.some((targetId) => {
      const target = bindings.find((binding) => binding.agentId === targetId)!;
      return !canShareAgentScope(acting, target);
    })) {
      throw new Error("Requested memory Agent is outside the acting AgentCluster");
    }
  } else if (bindings.length > 1) {
    const clusterId = bindings[0]?.clusterId;
    if (!clusterId || bindings.some((binding) => binding.clusterId !== clusterId)) {
      throw new Error("Cross-Agent memory access requires one shared AgentCluster");
    }
  }
  return targetIds.map((agentId) => bindings.find((binding) => binding.agentId === agentId)!);
}

export function canShareAgentScope(
  left: ResolvedAgentBinding,
  right: ResolvedAgentBinding,
): boolean {
  return left.agentId === right.agentId || (!!left.clusterId && left.clusterId === right.clusterId);
}
