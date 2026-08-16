import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  HttpException,
  HttpStatus,
  Inject,
} from "@nestjs/common";
import { type Request } from "express";
import { PRISMA_TOKEN, environmentScopeWhere } from "../shared/database.provider";
import { ProviderRegistryService } from "./provider-registry.service";
import { ScopedEnvService, credentialReference } from "./scoped-env.service";
import { ModelCatalogService } from "./model-catalog.service";
import type { RequestScope } from "../auth/scope.guard";
import { requireOperator } from "../auth/scope.guard";

const SAFE_KEY_SELECT = {
  id: true,
  provider: true,
  label: true,
  environmentKeyName: true,
  isDefault: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  lastUsedAt: true,
} as const;

function isUniqueConstraintError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === "P2002";
}

function isReferenceConstraintError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === "P2003";
}

@Controller("api/v1/agent/providers")
export class ProvidersController {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly registry: ProviderRegistryService,
    private readonly scopedEnv: ScopedEnvService,
    private readonly modelCatalog: ModelCatalogService,
  ) {}

  private getScope(req: Request): RequestScope {
    return (req as any).scope || {
      organizationId: "unknown",
      projectId: "unknown",
      environmentId: "unknown",
      userId: "unknown",
    };
  }

  private keyResult(row: any) {
    const { environmentKeyName, ...safe } = row;
    return { ...safe, envVarName: environmentKeyName };
  }

  private async lockProviderDefaults(tx: any, environmentId: string, provider: string): Promise<void> {
    await tx.$queryRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS locked",
      `${environmentId}:${provider}`,
    );
  }

  private async hasExecutableReference(
    tx: any,
    scope: RequestScope,
    key: { id: string; provider: string },
  ): Promise<boolean> {
    const rows = await tx.$queryRawUnsafe(
      `SELECT version.id
         FROM "ProviderKey" provider_key
         JOIN "Environment" environment ON environment.id = provider_key."environmentId"
         JOIN "Project" project ON project.id = environment."projectId"
         JOIN "AgentBinding" binding ON binding."environmentId" = environment.id
         JOIN "Agent" agent ON agent.id = binding."agentId" AND agent."projectId" = project.id
         JOIN "AgentVersion" version ON version."agentId" = agent.id
        WHERE provider_key.id = $1::uuid
          AND provider_key."environmentId" = $2::uuid
          AND provider_key.provider = $3
          AND project.id = $4::uuid
          AND project."organizationId" = $5::uuid
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
        LIMIT 1`,
      key.id,
      scope.environmentId,
      key.provider,
      scope.projectId,
      scope.organizationId,
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  @Get()
  async listProviders(@Req() req: Request) {
    const scope = this.getScope(req);
    return { providers: await this.registry.list(scope) };
  }

  @Get("keys")
  async listKeys(@Req() req: Request) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const rows = await this.prisma.providerKey.findMany({
      where: environmentScopeWhere(scope),
      orderBy: [{ provider: "asc" }, { isDefault: "desc" }, { createdAt: "asc" }],
      select: SAFE_KEY_SELECT,
    });
    const keys = await Promise.all(rows.map(async (row: any) => ({
      ...this.keyResult(row),
      envVarSet: (await this.scopedEnv.test(scope, row.environmentKeyName)).ok,
    })));
    return { keys };
  }

  @Post("keys")
  async createKey(
    @Req() req: Request,
    @Body() body: { provider: string; label: string; envVarName: string; isDefault?: boolean },
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);
    if (!body.provider || !body.label || !body.envVarName) {
      throw new HttpException("provider, label, and envVarName are required", HttpStatus.BAD_REQUEST);
    }
    const credential = await this.scopedEnv.findCredentialMetadata(scope, body.envVarName, body.provider);
    if (!credential) {
      throw new HttpException("Credential not found", HttpStatus.NOT_FOUND);
    }

    let key: any;
    try {
      key = await this.prisma.$transaction(async (tx: any) => {
        if (body.isDefault) {
          await this.lockProviderDefaults(tx, scope.environmentId, body.provider);
          await tx.providerKey.updateMany({
            where: {
              ...environmentScopeWhere(scope),
              provider: body.provider,
              isDefault: true,
            },
            data: { isDefault: false },
          });
        }
        return tx.providerKey.create({
          data: {
            environmentId: scope.environmentId,
            provider: body.provider,
            label: body.label,
            environmentKeyName: credential.name,
            encryptedReference: credentialReference(credential.id),
            isDefault: body.isDefault ?? false,
            createdBy: scope.userId,
          },
          select: SAFE_KEY_SELECT,
        });
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new HttpException("Provider key already exists", HttpStatus.CONFLICT);
      }
      throw error;
    }
    this.modelCatalog.invalidate(body.provider);
    return { key: this.keyResult(key) };
  }

  @Patch("keys/:id")
  async updateKey(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: { label?: string; isDefault?: boolean },
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);
    let updated: any;
    try {
      updated = await this.prisma.$transaction(async (tx: any) => {
        const existing = await tx.providerKey.findFirst({
          where: { id, ...environmentScopeWhere(scope) },
          select: { id: true, provider: true },
        });
        if (!existing) throw new HttpException("Key not found", HttpStatus.NOT_FOUND);
        if (body.isDefault) {
          await this.lockProviderDefaults(tx, scope.environmentId, existing.provider);
          await tx.providerKey.updateMany({
            where: {
              ...environmentScopeWhere(scope),
              provider: existing.provider,
              isDefault: true,
              id: { not: id },
            },
            data: { isDefault: false },
          });
        }
        return tx.providerKey.update({
          where: { id },
          data: {
            ...(body.label !== undefined ? { label: body.label } : {}),
            ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
          },
          select: SAFE_KEY_SELECT,
        });
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new HttpException("Provider key already exists", HttpStatus.CONFLICT);
      }
      throw error;
    }
    this.modelCatalog.invalidate(updated.provider);
    return { key: this.keyResult(updated) };
  }

  @Delete("keys/:id")
  async deleteKey(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    requireOperator(scope);
    let existing: { id: string; provider: string };
    try {
      existing = await this.prisma.$transaction(async (tx: any) => {
        const row = await tx.providerKey.findFirst({
          where: { id, ...environmentScopeWhere(scope) },
          select: { id: true, provider: true },
        });
        if (!row) throw new HttpException("Key not found", HttpStatus.NOT_FOUND);
        await this.lockProviderDefaults(tx, scope.environmentId, row.provider);
        if (await this.hasExecutableReference(tx, scope, row)) {
          throw new HttpException(
            "Cannot delete a provider key referenced by an executable agent version",
            HttpStatus.CONFLICT,
          );
        }
        await tx.providerKey.delete({ where: { id: row.id } });
        return row;
      });
    } catch (error) {
      if (isReferenceConstraintError(error)) {
        throw new HttpException(
          "Cannot delete a provider key referenced by an executable agent version",
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
    this.modelCatalog.invalidate(existing.provider);
    return { deleted: true };
  }
}
