import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { type Request } from "express";
import type { RequestScope } from "../auth/scope.guard";
import { requireOperator } from "../auth/scope.guard";
import { ModelCatalogService } from "./model-catalog.service";
import {
  ProviderKeyError,
  ProviderKeyService,
  type ProviderOperatorScope,
} from "./provider-key.service";
import { ProviderRegistryService } from "./provider-registry.service";
import { pageMetadata, parsePageRequest } from "../shared/pagination";

/** Provider metadata and same-Environment credential-link management. */
@Controller("api/v1/agent/providers")
export class ProvidersController {
  constructor(
    private readonly registry: ProviderRegistryService,
    private readonly modelCatalog: ModelCatalogService,
    private readonly providerKeys: ProviderKeyService,
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
    requireOperator(scope);
    const canonicalScope = await this.providerKeys.canonicalScope(scope, "metadata");
    const providers = await this.registry.list(canonicalScope);
    return { providers };
  }

  @Get("keys")
  async listKeys(
    @Req() req: Request,
    @Query("page") pageRaw?: string,
    @Query("limit") limitRaw?: string,
    @Query("offset") offsetRaw?: string,
    @Query("search") searchRaw?: string,
  ) {
    const scope = this.operatorScope(req);
    const request = parsePageRequest({ page: pageRaw, limit: limitRaw, offset: offsetRaw, search: searchRaw });
    const result = await this.providerKeys.listPage(scope, {
      limit: request.pageSize,
      offset: request.offset,
      search: request.search,
    });
    // Metadata listing must not decrypt or probe linked Credentials. A
    // ProviderKey can only be created against an active same-provider
    // Credential; live readiness is exposed by the explicitly gated provider
    // readiness/health routes.
    return {
      keys: result.items,
      items: result.items,
      total: result.total,
      limit: request.pageSize,
      offset: request.offset,
      hasMore: request.offset + result.items.length < result.total,
      pagination: pageMetadata(result.total, request),
      filters: { search: request.search },
    };
  }

  @Post("keys")
  async createKey(
    @Req() req: Request,
    @Body() body: { provider: string; label: string; envVarName: string; isDefault?: boolean },
  ) {
    const scope = this.operatorScope(req);
    const provider = body.provider?.trim();
    const label = body.label?.trim();
    const envVarName = body.envVarName?.trim();
    if (!provider || !label || !envVarName) {
      throw new HttpException("provider, label, and envVarName are required", HttpStatus.BAD_REQUEST);
    }
    try {
      const key = await this.providerKeys.create(scope, {
        provider,
        label,
        envVarName,
        isDefault: body.isDefault ?? false,
      });
      this.modelCatalog.invalidate(provider);
      return { key };
    } catch (error: unknown) {
      this.throwProviderKeyError(error);
    }
  }

  @Post("keys/byok")
  async createKeyWithSecret(
    @Req() req: Request,
    @Body() body: {
      provider: string;
      label: string;
      envVarName: string;
      plaintext: string;
      isDefault?: boolean;
    },
  ) {
    const scope = this.operatorScope(req);
    const provider = body.provider?.trim();
    const label = body.label?.trim();
    const envVarName = body.envVarName?.trim();
    const plaintext = body.plaintext;
    if (
      !provider ||
      !label ||
      !envVarName ||
      typeof plaintext !== "string" ||
      plaintext.length === 0 ||
      plaintext.length > 16_384
    ) {
      throw new HttpException(
        "provider, label, envVarName, and secret are required",
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      const key = await this.providerKeys.createWithSecret(scope, {
        provider,
        label,
        envVarName,
        plaintext,
        isDefault: body.isDefault ?? false,
      });
      this.modelCatalog.invalidate(provider);
      return { key };
    } catch (error: unknown) {
      this.throwProviderKeyError(error);
    }
  }

  @Post("keys/:id/rotate-secret")
  async rotateKeySecret(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: { plaintext: string },
  ) {
    const scope = this.operatorScope(req);
    if (
      typeof body.plaintext !== "string" ||
      body.plaintext.length === 0 ||
      body.plaintext.length > 16_384
    ) {
      throw new HttpException("secret is required", HttpStatus.BAD_REQUEST);
    }
    try {
      const key = await this.providerKeys.rotateSecret(scope, id, body.plaintext);
      this.modelCatalog.invalidate(key.provider);
      return { key };
    } catch (error: unknown) {
      this.throwProviderKeyError(error);
    }
  }

  @Patch("keys/:id")
  async updateKey(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: { label?: string; isDefault?: boolean },
  ) {
    const scope = this.operatorScope(req);
    try {
      const key = await this.providerKeys.update(scope, id, {
        ...(body.label !== undefined ? { label: body.label.trim() } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
      });
      this.modelCatalog.invalidate(key.provider);
      return { key };
    } catch (error: unknown) {
      this.throwProviderKeyError(error);
    }
  }

  @Delete("keys/:id")
  async deleteKey(@Req() req: Request, @Param("id") id: string) {
    const scope = this.operatorScope(req);
    try {
      const deleted = await this.providerKeys.delete(scope, id);
      this.modelCatalog.invalidate(deleted.provider);
      return { deleted: true };
    } catch (error: unknown) {
      this.throwProviderKeyError(error);
    }
  }

  private operatorScope(req: Request): ProviderOperatorScope {
    const scope = this.getScope(req);
    requireOperator(scope);
    return scope;
  }

  private throwProviderKeyError(error: unknown): never {
    if (error instanceof ProviderKeyError) {
      if (error.code === "pinned_agents") {
        throw new HttpException(
          {
            error: "pinned_agents",
            pinnedAgents: error.pinnedAgents ?? 0,
          },
          HttpStatus.CONFLICT,
        );
      }
      if (error.code === "already_exists") {
        throw new HttpException({ error: "already_exists" }, HttpStatus.CONFLICT);
      }
      if (error.code === "credential_unavailable") {
        throw new HttpException({ error: "credential_unavailable" }, HttpStatus.NOT_FOUND);
      }
      throw new HttpException({ error: "not_found" }, HttpStatus.NOT_FOUND);
    }
    throw error;
  }
}
