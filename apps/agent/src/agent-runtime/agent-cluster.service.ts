import { Injectable, Inject } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";

export interface ClusterRecord {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  name: string;
  slug: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  agents?: Array<{ id: string; name: string; slug: string }>;
}

export interface CreateClusterDto {
  name: string;
  slug: string;
  description?: string;
  primaryAgentId?: string;
  agentIds?: string[];
}

export interface UpdateClusterDto {
  name?: string;
  slug?: string;
  description?: string;
  primaryAgentId?: string;
}

@Injectable()
export class AgentClusterService {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: any) {}

  private scopeWhere(scope: RequestScope) {
    return {
      environmentId: scope.environmentId,
      environment: {
        project: {
          id: scope.projectId,
          organizationId: scope.organizationId,
        },
      },
    };
  }

  private includeGraph() {
    return {
      environment: { include: { project: true } },
      bindings: { include: { agent: { select: { id: true, name: true, slug: true } } } },
    };
  }

  private projectCluster(cluster: any): ClusterRecord {
    return {
      id: cluster.id,
      organizationId: cluster.environment.project.organizationId,
      projectId: cluster.environment.projectId,
      environmentId: cluster.environmentId,
      name: cluster.name,
      slug: cluster.slug,
      description: cluster.description ?? null,
      metadata: (cluster.metadata as Record<string, unknown> | null) ?? null,
      createdAt: cluster.createdAt,
      updatedAt: cluster.updatedAt,
      agents: (cluster.bindings ?? []).map((binding: any) => binding.agent),
    };
  }

  private async getRaw(clusterId: string, scope: RequestScope): Promise<any | null> {
    return this.prisma.agentCluster.findFirst({
      where: { id: clusterId, ...this.scopeWhere(scope) },
      include: this.includeGraph(),
    });
  }

  async create(scope: RequestScope, dto: CreateClusterDto): Promise<ClusterRecord> {
    const metadata: Record<string, unknown> = {};
    if (dto.primaryAgentId) metadata.primaryAgentId = dto.primaryAgentId;

    const cluster = await this.prisma.$transaction(async (tx: any) => {
      const environment = await tx.environment.findFirst({
        where: {
          id: scope.environmentId,
          project: { id: scope.projectId, organizationId: scope.organizationId },
        },
        select: { id: true },
      });
      if (!environment) throw new Error("Environment not found or access denied");
      if (dto.primaryAgentId) {
        const primary = await tx.agentBinding.findFirst({
          where: {
            agentId: dto.primaryAgentId,
            environmentId: environment.id,
            agent: { projectId: scope.projectId },
          },
          select: { id: true },
        });
        if (!primary) throw new Error("Primary agent not found or access denied");
      }

      const created = await tx.agentCluster.create({
        data: {
          environmentId: environment.id,
          name: dto.name,
          slug: dto.slug,
          description: dto.description ?? null,
          metadata: Object.keys(metadata).length ? metadata : undefined,
        },
      });

      if (dto.agentIds?.length) {
        await tx.agentBinding.updateMany({
          where: {
            agentId: { in: dto.agentIds },
            environmentId: environment.id,
            agent: { projectId: scope.projectId },
          },
          data: { clusterId: created.id },
        });
      }

      return tx.agentCluster.findUnique({
        where: { id: created.id },
        include: this.includeGraph(),
      });
    });

    return this.projectCluster(cluster);
  }

  async get(clusterId: string, scope: RequestScope): Promise<ClusterRecord | null> {
    const cluster = await this.getRaw(clusterId, scope);
    return cluster ? this.projectCluster(cluster) : null;
  }

  async list(scope: RequestScope): Promise<ClusterRecord[]> {
    const clusters = await this.prisma.agentCluster.findMany({
      where: this.scopeWhere(scope),
      include: this.includeGraph(),
      orderBy: { createdAt: "desc" },
    });
    return clusters.map((cluster: any) => this.projectCluster(cluster));
  }

  async update(clusterId: string, scope: RequestScope, dto: UpdateClusterDto): Promise<ClusterRecord> {
    const existing = await this.getRaw(clusterId, scope);
    if (!existing) throw new Error("Cluster not found or access denied");
    if (dto.primaryAgentId) {
      const primary = await this.prisma.agentBinding.findFirst({
        where: {
          agentId: dto.primaryAgentId,
          environmentId: scope.environmentId,
          agent: { projectId: scope.projectId },
          environment: {
            project: { id: scope.projectId, organizationId: scope.organizationId },
          },
        },
        select: { id: true },
      });
      if (!primary) throw new Error("Primary agent not found or access denied");
    }

    const metadata = { ...((existing.metadata as Record<string, unknown> | null) ?? {}) };
    if (dto.primaryAgentId !== undefined) {
      if (dto.primaryAgentId) metadata.primaryAgentId = dto.primaryAgentId;
      else delete metadata.primaryAgentId;
    }

    const cluster = await this.prisma.agentCluster.update({
      where: { id: clusterId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.slug !== undefined && { slug: dto.slug }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.primaryAgentId !== undefined && {
          metadata,
        }),
      },
      include: this.includeGraph(),
    });
    return this.projectCluster(cluster);
  }

  async delete(clusterId: string, scope: RequestScope): Promise<boolean> {
    const existing = await this.getRaw(clusterId, scope);
    if (!existing) return false;

    await this.prisma.$transaction([
      this.prisma.agentBinding.updateMany({
        where: { clusterId, environmentId: scope.environmentId },
        data: { clusterId: null },
      }),
      this.prisma.agentCluster.delete({ where: { id: clusterId } }),
    ]);
    return true;
  }

  async addAgent(
    clusterId: string,
    agentId: string,
    scope: RequestScope,
    _role?: string,
  ): Promise<ClusterRecord> {
    const cluster = await this.getRaw(clusterId, scope);
    if (!cluster) throw new Error("Cluster not found or access denied");

    const binding = await this.prisma.agentBinding.findFirst({
      where: {
        agentId,
        environmentId: scope.environmentId,
        agent: { projectId: scope.projectId },
        environment: { project: { id: scope.projectId, organizationId: scope.organizationId } },
      },
      select: { id: true },
    });
    if (!binding) throw new Error("Agent not found or access denied");

    const primaryAgentId = (cluster.metadata as Record<string, unknown> | null)?.primaryAgentId;
    const updates = !primaryAgentId
      ? { metadata: { ...((cluster.metadata as object | null) ?? {}), primaryAgentId: agentId } }
      : undefined;

    await this.prisma.$transaction([
      this.prisma.agentBinding.update({ where: { id: binding.id }, data: { clusterId } }),
      ...(updates
        ? [this.prisma.agentCluster.update({ where: { id: clusterId }, data: updates })]
        : []),
    ]);
    return (await this.get(clusterId, scope))!;
  }

  async removeAgent(clusterId: string, agentId: string, scope: RequestScope): Promise<ClusterRecord> {
    const cluster = await this.getRaw(clusterId, scope);
    if (!cluster) throw new Error("Cluster not found or access denied");

    await this.prisma.agentBinding.updateMany({
      where: {
        agentId,
        clusterId,
        environmentId: scope.environmentId,
        agent: { projectId: scope.projectId },
      },
      data: { clusterId: null },
    });

    const metadata = { ...((cluster.metadata as Record<string, unknown> | null) ?? {}) };
    if (metadata.primaryAgentId === agentId) {
      const next = cluster.bindings.find((binding: any) => binding.agentId !== agentId);
      if (next) metadata.primaryAgentId = next.agentId;
      else delete metadata.primaryAgentId;
      await this.prisma.agentCluster.update({
        where: { id: clusterId },
        data: { metadata },
      });
    }

    return (await this.get(clusterId, scope))!;
  }

  async getClusterForAgent(agentId: string, scope: RequestScope): Promise<ClusterRecord | null> {
    const binding = await this.prisma.agentBinding.findFirst({
      where: {
        agentId,
        environmentId: scope.environmentId,
        agent: { projectId: scope.projectId },
        environment: { project: { id: scope.projectId, organizationId: scope.organizationId } },
      },
      select: { clusterId: true },
    });
    if (!binding?.clusterId) return null;
    return this.get(binding.clusterId, scope);
  }
}
