import { Injectable, Inject } from "@nestjs/common";
import {
  PRISMA_TOKEN,
  PLATOS_SECRET_STORE_TOKEN,
  type ControlDatabaseClient,
} from "../shared/database.provider";
import {
  EnvironmentVariableStore,
  authorizeEnvironmentOperator,
  type EnvironmentOperatorAuthorization,
  type OperatorAuthorization,
  type PlatosSecretStore,
} from "@platos/tenancy-database";
import type { RequestScope } from "../auth/scope.guard";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

/**
 * Theme MCPF-W6 — Environment management service.
 *
 * Environment variables are Environment-owned. Secret values are stored only
 * in the canonical Credential envelope store and list responses are redacted.
 *
 * Three architectural rules baked in:
 *   1. **Cross-tenant scope filtering** — every read scopes by
 *      `(organizationId, projectId)`. Caller must be a member of the
 *      org via OrgMember.
 *   2. **Owner-gated mutations** — create/delete Environment writes require
 *      an Organization ADMIN or OWNER role.
 *   3. **Secrets never leak through MCP** — credential methods fail with a
 *      stable error before reading, writing, logging, or auditing plaintext.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
@Injectable()
export class EnvironmentService {
  private readonly variables: EnvironmentVariableStore;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
    @Inject(PLATOS_SECRET_STORE_TOKEN) secretStore: PlatosSecretStore,
  ) {
    this.variables = new EnvironmentVariableStore(prisma, secretStore);
  }

  /**
   * List runtime environments visible inside the caller's project scope.
   * Caller must be a member of the org. Soft-archived envs are filtered
   * out by default.
   */
  async list(scope: ScopeTuple, userId: string | null) {
    await this.requireMember(scope.organizationId, userId);
    const envs = await this.prisma.environment.findMany({
      where: {
        projectId: scope.projectId,
        project: { organizationId: scope.organizationId },
        archivedAt: null,
      },
      orderBy: { slug: "asc" },
      select: {
        id: true,
        slug: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
      },
    });
    return envs;
  }

  /**
   * Create a new Environment in the caller's project. Owner-gated.
   * Validates slug format.
   *
   * Note: this is a power-user surface. Most operators should use the
   * webapp UI which also wires up the dev sentinel + member binding.
   * This MCP tool exists for scripted environment provisioning.
   */
  async create(
    scope: ScopeTuple,
    userId: string | null,
    opts: {
      slug: string;
      type?: "PRODUCTION" | "STAGING" | "DEVELOPMENT" | "PREVIEW";
    },
  ) {
    await this.requireAdmin(scope.organizationId, userId);
    const slug = String(opts.slug || "").trim().toLowerCase();
    if (!SLUG_RE.test(slug)) throw new Error("slug_invalid");
    const project = await this.prisma.project.findFirst({
      where: {
        id: scope.projectId,
        organizationId: scope.organizationId,
        archivedAt: null,
      },
      select: { id: true },
    });
    if (!project) throw new Error("not_found");
    try {
      const created = await this.prisma.environment.create({
        data: {
          slug,
          name: slug,
          projectId: project.id,
        },
        select: {
          id: true,
          slug: true,
          name: true,
          createdAt: true,
        },
      });
      return created;
    } catch (err: any) {
      // Unique constraint on (projectId, slug).
      if (String(err?.code) === "P2002") throw new Error("slug_taken");
      throw err;
    }
  }

  /**
   * Delete (archive) an Environment. Owner-gated. Refuses when
   * any active AgentBinding or Thread references the Environment (would
   * break running agents). Soft-deletes by setting `archivedAt = now()`
   * — same semantic the webapp uses.
   */
  async deleteEnvironment(
    scope: ScopeTuple,
    userId: string | null,
    opts: { environmentId: string },
  ) {
    await this.requireAdmin(scope.organizationId, userId);
    const target = await this.prisma.environment.findFirst({
      where: {
        id: opts.environmentId,
        projectId: scope.projectId,
        project: { organizationId: scope.organizationId },
      },
      select: { id: true, archivedAt: true, slug: true },
    });
    if (!target) throw new Error("not_found");
    if (target.archivedAt) return { archived: false, alreadyArchived: true };
    if (["prod", "production"].includes(target.slug.toLowerCase())) {
      throw new Error("production_env_protected");
    }
    // Block when agents reference the env.
    const [agentCount, threadCount] = await Promise.all([
      this.prisma.agentBinding.count({
        where: {
          environmentId: target.id,
          environment: {
            project: { id: scope.projectId, organizationId: scope.organizationId },
          },
          agent: { projectId: scope.projectId, isActive: true },
        },
      }),
      this.prisma.thread.count({
        where: {
          environmentId: target.id,
          environment: {
            project: { id: scope.projectId, organizationId: scope.organizationId },
          },
          archivedAt: null,
        },
      }),
    ]);
    if (agentCount > 0) throw new Error(`env_in_use_by_agents:${agentCount}`);
    if (threadCount > 0) throw new Error(`env_in_use_by_threads:${threadCount}`);
    await this.prisma.environment.update({
      where: { id: target.id },
      data: { archivedAt: new Date() },
    });
    return { archived: true };
  }

  async listSecrets(scope: ScopeTuple, userId: string | null) {
    const authorization = await this.authorize(scope, userId, "metadata");
    const variables = await this.variables.list(authorization);
    return variables.map((variable) => ({
      name: variable.key,
      version: String(variable.version),
      isSecret: variable.kind === "SECRET",
      hasSecret: variable.hasSecret,
      createdAt: variable.createdAt,
      updatedAt: variable.updatedAt,
    }));
  }

  async setSecret(
    scope: ScopeTuple,
    userId: string | null,
    opts: { name: string; value: string },
  ) {
    const authorization = await this.authorize(scope, userId, "secret:mutate");
    const variable = await this.variables.set({
      authorization,
      key: opts.name,
      value: opts.value,
      secret: true,
    });
    return { ok: true as const, name: variable.key, version: String(variable.version) };
  }

  async deleteSecret(
    scope: ScopeTuple,
    userId: string | null,
    opts: { name: string },
  ) {
    const authorization = await this.authorize(scope, userId, "secret:mutate");
    const result = await this.variables.delete({ authorization, key: opts.name });
    return { deleted: result.deleted, name: result.key };
  }

  // ── Authz helpers ─────────────────────────────────────────────────

  private async requireMember(orgId: string, userId: string | null): Promise<void> {
    if (!userId) throw new Error("access_denied");
    const m = await this.prisma.organizationMembership.findFirst({
      where: { organizationId: orgId, userId, deactivatedAt: null },
      select: { id: true },
    });
    if (!m) throw new Error("access_denied");
  }

  private async requireAdmin(orgId: string, userId: string | null): Promise<void> {
    if (!userId) throw new Error("access_denied");
    const m = await this.prisma.organizationMembership.findFirst({
      where: { organizationId: orgId, userId, deactivatedAt: null },
      select: { role: true },
    });
    if (!m || m.role === "MEMBER") throw new Error("access_denied");
  }

  private async authorize(
    scope: ScopeTuple,
    userId: string | null,
    access: "metadata" | "secret:mutate",
  ): Promise<EnvironmentOperatorAuthorization> {
    if (!userId) throw new Error("access_denied");
    const operator: OperatorAuthorization = {
      sessionId: "platos-agent-environment-control",
      actorUserId: userId,
      effectiveUserId: userId,
      email: "",
      expiresAt: new Date(Date.now() + 60_000),
      mfaVerifiedAt: null,
      impersonation: null,
    };
    try {
      const authorization = await authorizeEnvironmentOperator(
        this.prisma,
        operator,
        scope.environmentId,
        access,
      );
      if (
        authorization.organizationId !== scope.organizationId ||
        authorization.projectId !== scope.projectId
      ) {
        throw new Error("access_denied");
      }
      return authorization;
    } catch {
      throw new Error("access_denied");
    }
  }
}
