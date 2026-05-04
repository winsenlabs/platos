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

  async create(scope: RequestScope, dto: CreateClusterDto): Promise<ClusterRecord> {
    const metadata: Record<string, unknown> = {};
    if (dto.primaryAgentId) metadata.primaryAgentId = dto.primaryAgentId;

    const cluster = await this.prisma.platosAgentCluster.create({
      data: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        name: dto.name,
        slug: dto.slug,
        description: dto.description ?? null,
        metadata: Object.keys(metadata).length ? metadata : null,
      },
      include: { agents: { select: { id: true, name: true, slug: true } } },
    });

    // Assign initial agents if provided.
    if (dto.agentIds && dto.agentIds.length > 0) {
      await this.prisma.platosAgent.updateMany({
        where: {
          id: { in: dto.agentIds },
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        data: { clusteringId: cluster.id },
      });
    }

    return cluster as ClusterRecord;
  }

  async get(clusterId: string, scope: RequestScope): Promise<ClusterRecord | null> {
    const cluster = await this.prisma.platosAgentCluster.findFirst({
      where: {
        id: clusterId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      include: { agents: { select: { id: true, name: true, slug: true } } },
    });
    return cluster as ClusterRecord | null;
  }

  async list(scope: RequestScope): Promise<ClusterRecord[]> {
    const clusters = await this.prisma.platosAgentCluster.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      include: { agents: { select: { id: true, name: true, slug: true } } },
      orderBy: { createdAt: "desc" },
    });
    return clusters as ClusterRecord[];
  }

  async update(clusterId: string, scope: RequestScope, dto: UpdateClusterDto): Promise<ClusterRecord> {
    const existing = await this.get(clusterId, scope);
    if (!existing) throw new Error("Cluster not found or access denied");

    const metadata = (existing.metadata ?? {}) as Record<string, unknown>;
    if (dto.primaryAgentId !== undefined) metadata.primaryAgentId = dto.primaryAgentId;

    const cluster = await this.prisma.platosAgentCluster.update({
      where: { id: clusterId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.slug !== undefined && { slug: dto.slug }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.primaryAgentId !== undefined && { metadata }),
      },
      include: { agents: { select: { id: true, name: true, slug: true } } },
    });
    return cluster as ClusterRecord;
  }

  async delete(clusterId: string, scope: RequestScope): Promise<void> {
    const existing = await this.get(clusterId, scope);
    if (!existing) throw new Error("Cluster not found or access denied");

    // Remove all agents from cluster before deleting.
    await this.prisma.platosAgent.updateMany({
      where: { clusteringId: clusterId },
      data: { clusteringId: null },
    });

    await this.prisma.platosAgentCluster.delete({ where: { id: clusterId } });
  }

  async addAgent(clusterId: string, agentId: string, scope: RequestScope, role?: string): Promise<void> {
    const cluster = await this.get(clusterId, scope);
    if (!cluster) throw new Error("Cluster not found or access denied");

    const agent = await this.prisma.platosAgent.findFirst({
      where: { id: agentId, organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId },
      select: { id: true },
    });
    if (!agent) throw new Error("Agent not found or access denied");

    // Update role in metadata if provided.
    const updates: Record<string, unknown> = {};
    if (role) {
      const metadata = (cluster.metadata ?? {}) as Record<string, unknown>;
      const roles = (metadata.roles ?? {}) as Record<string, string>;
      roles[agentId] = role;
      metadata.roles = roles;
      updates.metadata = metadata;
    }

    await this.prisma.$transaction([
      this.prisma.platosAgent.update({ where: { id: agentId }, data: { clusteringId: clusterId } }),
      ...(Object.keys(updates).length
        ? [this.prisma.platosAgentCluster.update({ where: { id: clusterId }, data: updates })]
        : []),
    ]);
  }

  async removeAgent(clusterId: string, agentId: string, scope: RequestScope): Promise<void> {
    const cluster = await this.get(clusterId, scope);
    if (!cluster) throw new Error("Cluster not found or access denied");

    await this.prisma.platosAgent.updateMany({
      where: {
        id: agentId,
        clusteringId: clusterId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      data: { clusteringId: null },
    });
  }

  async getMembers(clusterId: string, scope: RequestScope): Promise<Array<{ id: string; name: string; slug: string }>> {
    const cluster = await this.get(clusterId, scope);
    if (!cluster) return [];
    return cluster.agents ?? [];
  }

  /** Resolve the cluster (if any) that an agent belongs to. */
  async resolveClusterForAgent(agentId: string, scope: RequestScope): Promise<ClusterRecord | null> {
    const agent = await this.prisma.platosAgent.findFirst({
      where: { id: agentId, organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId },
      select: { clusteringId: true },
    });
    if (!agent?.clusteringId) return null;
    return this.get(agent.clusteringId, scope);
  }
}
