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
import { PRISMA_TOKEN } from "../shared/database.provider";
import { ProviderRegistryService } from "./provider-registry.service";
import { ScopedEnvService } from "./scoped-env.service";
import { ModelCatalogService } from "./model-catalog.service";
import type { RequestScope } from "../auth/scope.guard";

/**
 * PIFSP-14 — Provider key management endpoints.
 *
 *   GET    /api/v1/agent/providers                       — list provider states
 *   GET    /api/v1/agent/providers/keys                  — list all provider keys in scope
 *   POST   /api/v1/agent/providers/keys                  — create a key
 *   PATCH  /api/v1/agent/providers/keys/:id              — rename / set default
 *   DELETE /api/v1/agent/providers/keys/:id              — delete (fails if agents pinned)
 */
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

  @Get()
  async listProviders(@Req() req: Request) {
    const scope = this.getScope(req);
    const providers = await this.registry.list({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    });
    return { providers };
  }

  @Get("keys")
  async listKeys(@Req() req: Request) {
    const scope = this.getScope(req);
    const keys = await this.prisma.platosProviderKey.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      orderBy: [{ provider: "asc" }, { isDefault: "desc" }, { createdAt: "asc" }],
      select: {
        id: true,
        provider: true,
        label: true,
        envVarName: true,
        isDefault: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
        lastUsedAt: true,
      },
    });
    // Enrich each key with whether the env var is actually set in SecretStore.
    const enriched = await Promise.all(
      keys.map(async (k: any) => ({
        ...k,
        envVarSet: !!(await this.scopedEnv.get(
          { organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId },
          k.envVarName,
        )),
      })),
    );
    return { keys: enriched };
  }

  @Post("keys")
  async createKey(
    @Req() req: Request,
    @Body() body: { provider: string; label: string; envVarName: string; isDefault?: boolean },
  ) {
    const scope = this.getScope(req);
    if (!body.provider || !body.label || !body.envVarName) {
      throw new HttpException("provider, label, and envVarName are required", HttpStatus.BAD_REQUEST);
    }

    // If isDefault requested, clear any existing default for this provider.
    if (body.isDefault) {
      await this.prisma.platosProviderKey.updateMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          provider: body.provider,
          isDefault: true,
        },
        data: { isDefault: false },
      });
    }

    const key = await this.prisma.platosProviderKey.create({
      data: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        provider: body.provider,
        label: body.label,
        envVarName: body.envVarName,
        isDefault: body.isDefault ?? false,
        createdBy: scope.userId,
      },
      select: {
        id: true,
        provider: true,
        label: true,
        envVarName: true,
        isDefault: true,
        createdAt: true,
      },
    });
    // New key may unlock a different upstream catalog (e.g. a Together
    // enterprise account vs. trial). Drop the in-memory cache so the next
    // picker load fetches /v1/models with the new credential.
    this.modelCatalog.invalidate(body.provider);
    return { key };
  }

  @Patch("keys/:id")
  async updateKey(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: { label?: string; isDefault?: boolean },
  ) {
    const scope = this.getScope(req);
    const existing = await this.prisma.platosProviderKey.findFirst({
      where: { id, organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId },
    });
    if (!existing) throw new HttpException("Key not found", HttpStatus.NOT_FOUND);

    if (body.isDefault) {
      await this.prisma.platosProviderKey.updateMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          provider: existing.provider,
          isDefault: true,
          id: { not: id },
        },
        data: { isDefault: false },
      });
    }

    const updated = await this.prisma.platosProviderKey.update({
      where: { id },
      data: {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
      },
      select: { id: true, provider: true, label: true, envVarName: true, isDefault: true, updatedAt: true },
    });
    return { key: updated };
  }

  @Delete("keys/:id")
  async deleteKey(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    const existing = await this.prisma.platosProviderKey.findFirst({
      where: { id, organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId },
    });
    if (!existing) throw new HttpException("Key not found", HttpStatus.NOT_FOUND);

    // Block deletion if any agents are pinned to this key.
    const pinnedCount = await this.prisma.platosAgent.count({
      where: {
        providerKeyId: id,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
    if (pinnedCount > 0) {
      throw new HttpException(
        `Cannot delete — ${pinnedCount} agent(s) are pinned to this key. Update them first.`,
        HttpStatus.CONFLICT,
      );
    }

    await this.prisma.platosProviderKey.delete({ where: { id } });
    this.modelCatalog.invalidate(existing.provider);
    return { deleted: true };
  }
}
