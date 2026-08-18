import { Inject, Injectable } from "@nestjs/common";
import {
  CREDENTIAL_SAFE_SELECT,
  PROVIDER_KEY_SAFE_SELECT,
  Prisma,
  PlatosSecretStore,
  PlatosSecretStoreError,
  authorizeEnvironmentOperator,
  type EnvironmentOperatorAuthorization,
  type OperatorAuthorization,
  type PrismaClient,
} from "@platos/tenancy-database";
import type { RequestScope } from "../auth/scope.guard";
import {
  PLATOS_SECRET_STORE_TOKEN,
  PRISMA_TOKEN,
} from "../shared/database.provider";
import type { ScopeTuple } from "./scoped-env.service";

export type ProviderOperatorScope = ScopeTuple &
  Pick<RequestScope, "userId" | "sessionId" | "principal" | "operatorUserId">;

export type ProviderKeyErrorCode =
  | "not_found"
  | "credential_unavailable"
  | "already_exists"
  | "pinned_agents";

export class ProviderKeyError extends Error {
  constructor(
    public readonly code: ProviderKeyErrorCode,
    public readonly pinnedAgents?: number
  ) {
    super(code);
    this.name = "ProviderKeyError";
  }
}

export interface SafeProviderKeyView {
  id: string;
  environmentId: string;
  credentialId: string;
  provider: string;
  label: string;
  envVarName: string;
  isDefault: boolean;
  createdBy: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Clean-schema ProviderKey/Credential repository for agent control surfaces. */
@Injectable()
export class ProviderKeyService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(PLATOS_SECRET_STORE_TOKEN) private readonly secretStore: PlatosSecretStore
  ) {}

  async list(scope: ProviderOperatorScope, provider?: string): Promise<SafeProviderKeyView[]> {
    const authorization = await this.authorize(scope, "metadata");
    const keys = await this.prisma.providerKey.findMany({
      where: {
        environmentId: authorization.environmentId,
        ...(provider ? { provider } : {}),
      },
      orderBy: [{ provider: "asc" }, { isDefault: "desc" }, { createdAt: "asc" }],
      select: PROVIDER_KEY_SAFE_SELECT,
    });
    return keys.map(toView);
  }

  async get(scope: ProviderOperatorScope, id: string): Promise<SafeProviderKeyView> {
    const authorization = await this.authorize(scope, "metadata");
    const key = await this.prisma.providerKey.findFirst({
      where: { id, environmentId: authorization.environmentId },
      select: PROVIDER_KEY_SAFE_SELECT,
    });
    if (!key) throw new ProviderKeyError("not_found");
    return toView(key);
  }

  async create(
    scope: ProviderOperatorScope,
    input: { provider: string; label: string; envVarName: string; isDefault: boolean }
  ): Promise<SafeProviderKeyView> {
    const authorization = await this.authorize(scope, "secret:mutate");
    try {
      const key = await this.secretStore.linkProviderKey({
        authorization,
        ...input,
      });
      return toView(key);
    } catch (error: unknown) {
      if (error instanceof ProviderKeyError) throw error;
      if (error instanceof PlatosSecretStoreError && error.code === "credential_unavailable") {
        throw new ProviderKeyError("credential_unavailable");
      }
      if ((error as { code?: string })?.code === "P2002") {
        throw new ProviderKeyError("already_exists");
      }
      throw error;
    }
  }

  async update(
    scope: ProviderOperatorScope,
    id: string,
    input: { label?: string; isDefault?: boolean }
  ): Promise<SafeProviderKeyView> {
    const authorization = await this.authorize(scope, "secret:mutate");
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.providerKey.findFirst({
        where: { id, environmentId: authorization.environmentId },
        select: PROVIDER_KEY_SAFE_SELECT,
      });
      if (!existing) throw new ProviderKeyError("not_found");
      if (input.isDefault) {
        await tx.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${authorization.environmentId}:${existing.provider}`}, 0)
          )::text AS locked
        `);
        await tx.providerKey.updateMany({
          where: {
            environmentId: authorization.environmentId,
            provider: existing.provider,
            isDefault: true,
            id: { not: id },
          },
          data: { isDefault: false },
        });
      }
      const updated = await tx.providerKey.update({
        where: { id },
        data: {
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        },
        select: PROVIDER_KEY_SAFE_SELECT,
      });
      return toView(updated);
    });
  }

  /** Relink a ProviderKey to an existing same-Environment credential name. */
  async rotateReference(
    scope: ProviderOperatorScope,
    id: string,
    input: { envVarName: string; label?: string }
  ): Promise<{ key: SafeProviderKeyView; previousEnvVarName: string }> {
    const authorization = await this.authorize(scope, "secret:mutate");
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.providerKey.findFirst({
          where: { id, environmentId: authorization.environmentId },
          select: PROVIDER_KEY_SAFE_SELECT,
        });
        if (!existing) throw new PlatosSecretStoreError("provider_key_unavailable");
        const credential = await tx.credential.findFirst({
          where: {
            environmentId: authorization.environmentId,
            name: input.envVarName,
            provider: existing.provider,
            revokedAt: null,
            activeSecretVersionId: { not: null },
          },
          select: CREDENTIAL_SAFE_SELECT,
        });
        if (!credential?.activeSecretVersion) {
          throw new PlatosSecretStoreError("credential_unavailable");
        }
        const key = await tx.providerKey.update({
          where: { id: existing.id },
          data: {
            credentialId: credential.id,
            environmentKeyName: credential.name,
            ...(input.label ? { label: input.label } : {}),
          },
          select: PROVIDER_KEY_SAFE_SELECT,
        });
        await tx.credentialAudit.create({
          data: {
            environmentId: authorization.environmentId,
            credentialId: credential.id,
            action: "PROVIDER_KEY_RELINK",
            outcome: "SUCCESS",
            actorType: "operator",
            actorId: authorization.actorUserId,
            effectiveUserId: authorization.effectiveUserId,
            secretRevision: credential.activeSecretVersion.secretRevision,
            fromRootKeyVersion: credential.activeSecretVersion.rootKeyVersion,
            toRootKeyVersion: credential.activeSecretVersion.rootKeyVersion,
          },
        });
        return { key, previousEnvVarName: existing.environmentKeyName };
      });
      return { key: toView(result.key), previousEnvVarName: result.previousEnvVarName };
    } catch (error: unknown) {
      if (error instanceof PlatosSecretStoreError && error.code === "credential_unavailable") {
        throw new ProviderKeyError("credential_unavailable");
      }
      if (error instanceof PlatosSecretStoreError && error.code === "provider_key_unavailable") {
        throw new ProviderKeyError("not_found");
      }
      throw error;
    }
  }

  async delete(scope: ProviderOperatorScope, id: string): Promise<SafeProviderKeyView> {
    const authorization = await this.authorize(scope, "secret:mutate");
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.providerKey.findFirst({
          where: { id, environmentId: authorization.environmentId },
          select: PROVIDER_KEY_SAFE_SELECT,
        });
        if (!existing) throw new ProviderKeyError("not_found");
        const references = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT version.id
            FROM "ProviderKey" provider_key
            JOIN "Environment" environment ON environment.id = provider_key."environmentId"
            JOIN "Project" project ON project.id = environment."projectId"
            JOIN "AgentBinding" binding ON binding."environmentId" = environment.id
            JOIN "Agent" agent ON agent.id = binding."agentId" AND agent."projectId" = project.id
            JOIN "AgentVersion" version ON version."agentId" = agent.id
           WHERE provider_key.id = ${existing.id}::uuid
             AND project.id = ${authorization.projectId}::uuid
             AND project."organizationId" = ${authorization.organizationId}::uuid
             AND (
               (
                 version."memoryConfig" #>> '{__runtime,providerKeyId}' = provider_key.id::text
                 AND split_part(version.model, ':', 1) = provider_key.provider
               )
               OR EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements(version."modelRoutes") route
                  WHERE split_part(COALESCE(route ->> 'model', ''), ':', 1) = provider_key.provider
                    AND (
                      route ->> 'providerCredentialId' = provider_key.id::text
                      OR route ->> 'providerKeyId' = provider_key.id::text
                    )
               )
             )
           LIMIT 1
        `);
        if (references.length > 0) throw new ProviderKeyError("pinned_agents", references.length);
        await tx.providerKey.delete({ where: { id: existing.id } });
        return toView(existing);
      });
    } catch (error: unknown) {
      if ((error as { code?: string })?.code === "P2003") {
        throw new ProviderKeyError("pinned_agents");
      }
      throw error;
    }
  }

  async existingIds(scope: ProviderOperatorScope, ids: string[]): Promise<Set<string>> {
    const authorization = await this.authorize(scope, "metadata");
    const keys = await this.prisma.providerKey.findMany({
      where: { id: { in: ids }, environmentId: authorization.environmentId },
      select: { id: true },
    });
    return new Set(keys.map((key) => key.id));
  }

  /** Resolve and return only canonical ancestry for another provider control surface. */
  async canonicalScope(
    scope: ProviderOperatorScope,
    access: "metadata" | "secret:mutate",
  ): Promise<Pick<EnvironmentOperatorAuthorization, "organizationId" | "projectId" | "environmentId">> {
    const authorization = await this.authorize(scope, access);
    return {
      organizationId: authorization.organizationId,
      projectId: authorization.projectId,
      environmentId: authorization.environmentId,
    };
  }

  private async authorize(
    scope: ProviderOperatorScope,
    access: "metadata" | "secret:mutate"
  ): Promise<EnvironmentOperatorAuthorization> {
    if (scope.principal !== "operator") throw new ProviderKeyError("not_found");
    const operator: OperatorAuthorization = {
      sessionId: scope.sessionId || "platos-agent-control-plane",
      actorUserId: scope.operatorUserId || scope.userId,
      effectiveUserId: scope.userId,
      email: "",
      expiresAt: new Date(Date.now() + 60_000),
      mfaVerifiedAt: null,
      impersonation: scope.operatorUserId
        ? {
            active: true,
            actorUserId: scope.operatorUserId,
            targetUserId: scope.userId,
          }
        : null,
    };
    const authorization = await authorizeEnvironmentOperator(
      this.prisma,
      operator,
      scope.environmentId,
      access
    );
    if (
      authorization.organizationId !== scope.organizationId ||
      authorization.projectId !== scope.projectId
    ) {
      throw new ProviderKeyError("not_found");
    }
    return authorization;
  }
}

function toView(key: {
  id: string;
  environmentId: string;
  credentialId: string;
  provider: string;
  label: string;
  environmentKeyName: string;
  isDefault: boolean;
  createdBy: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): SafeProviderKeyView {
  return {
    id: key.id,
    environmentId: key.environmentId,
    credentialId: key.credentialId,
    provider: key.provider,
    label: key.label,
    envVarName: key.environmentKeyName,
    isDefault: key.isDefault,
    createdBy: key.createdBy,
    lastUsedAt: key.lastUsedAt,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
  };
}
