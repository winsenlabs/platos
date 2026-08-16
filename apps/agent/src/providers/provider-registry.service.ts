import { Injectable, Inject } from "@nestjs/common";
import { PRISMA_TOKEN, environmentScopeWhere } from "../shared/database.provider";
import { PROVIDER_MANIFESTS, getManifest, type ProviderManifest } from "./manifests";
import { ScopedEnvService } from "./scoped-env.service";
import { ModelCatalogService } from "./model-catalog.service";
import type { RequestScope } from "../auth/scope.guard";

export type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export interface ProviderState {
  id: string;
  displayName: string;
  description: string;
  requiredEnv: Array<{ name: string; set: boolean }>;
  optionalEnv: string[];
  envReady: boolean;
  enabled: boolean;
  linked: boolean;
  linkedAt: string | null;
  models: string[];
}

/** Clean-schema provider registry backed by EnvironmentProvider and ProviderKey. */
@Injectable()
export class ProviderRegistryService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly scopedEnv: ScopedEnvService,
    private readonly modelCatalog: ModelCatalogService,
  ) {}

  async list(scope: ScopeTuple): Promise<ProviderState[]> {
    const rows = await this.prisma.environmentProvider.findMany({
      where: environmentScopeWhere(scope),
      select: { providerId: true, enabled: true, linkedAt: true },
    });
    const linkedById = new Map<string, { enabled: boolean; linkedAt: Date }>(
      rows.map((row: any) => [row.providerId, row]),
    );
    return Promise.all(
      PROVIDER_MANIFESTS.map((manifest) => this.stateFor(scope, manifest, linkedById.get(manifest.id))),
    );
  }

  async getOne(scope: ScopeTuple, providerId: string): Promise<ProviderState | undefined> {
    const manifest = getManifest(providerId);
    if (!manifest) return undefined;
    const row = await this.prisma.environmentProvider.findFirst({
      where: { ...environmentScopeWhere(scope), providerId },
      select: { enabled: true, linkedAt: true },
    });
    return this.stateFor(scope, manifest, row ?? undefined);
  }

  async link(scope: ScopeTuple, providerId: string): Promise<ProviderState> {
    const manifest = getManifest(providerId);
    if (!manifest) throw new Error(`Unknown providerId: ${providerId}`);
    await this.writeProviderState(scope, providerId, true);
    return (await this.getOne(scope, providerId))!;
  }

  async unlink(scope: ScopeTuple, providerId: string): Promise<void> {
    await this.prisma.environmentProvider.deleteMany({
      where: { ...environmentScopeWhere(scope), providerId },
    });
  }

  async setEnabled(scope: ScopeTuple, providerId: string, enabled: boolean): Promise<ProviderState> {
    const manifest = getManifest(providerId);
    if (!manifest) throw new Error(`Unknown providerId: ${providerId}`);
    await this.writeProviderState(scope, providerId, enabled);
    return (await this.getOne(scope, providerId))!;
  }

  async availableModels(
    scope: ScopeTuple,
  ): Promise<Array<{ provider: string; displayName: string; models: string[] }>> {
    const states = await this.list(scope);
    return states
      .filter((state) => state.linked && state.enabled && state.envReady)
      .map((state) => ({ provider: state.id, displayName: state.displayName, models: state.models }));
  }

  private async writeProviderState(scope: ScopeTuple, providerId: string, enabled: boolean): Promise<void> {
    await this.prisma.$transaction(async (tx: any) => {
      const environment = await tx.environment.findFirst({
        where: {
          id: scope.environmentId,
          project: { id: scope.projectId, organizationId: scope.organizationId },
        },
        select: { id: true },
      });
      if (!environment) throw new Error("Environment not found or access denied");
      await tx.environmentProvider.upsert({
        where: {
          environmentId_providerId: {
            environmentId: scope.environmentId,
            providerId,
          },
        },
        create: { environmentId: scope.environmentId, providerId, enabled },
        update: { enabled },
      });
    });
  }

  private async stateFor(
    scope: ScopeTuple,
    manifest: ProviderManifest,
    row?: { enabled: boolean; linkedAt: Date },
  ): Promise<ProviderState> {
    const requiredEnv: Array<{ name: string; set: boolean }> = [];
    for (const [index, name] of manifest.requiredEnv.entries()) {
      const set = index === 0
        ? await this.scopedEnv.hasProviderCredential(scope, manifest.id)
        : !!(await this.scopedEnv.get(scope, name));
      requiredEnv.push({ name, set });
    }
    const envReady = requiredEnv.every((entry) => entry.set);

    let models = manifest.models;
    if (row?.enabled && envReady && manifest.modelsEndpoint) {
      const live = await this.modelCatalog.listFor(scope, manifest);
      if (live.length > 0) {
        const seen = new Set(manifest.models);
        models = [
          ...manifest.models,
          ...live.filter((id) => {
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          }),
        ];
      }
    }

    return {
      id: manifest.id,
      displayName: manifest.displayName,
      description: manifest.description,
      requiredEnv,
      optionalEnv: manifest.optionalEnv,
      envReady,
      enabled: row?.enabled ?? false,
      linked: !!row,
      linkedAt: row?.linkedAt.toISOString() ?? null,
      models,
    };
  }
}
