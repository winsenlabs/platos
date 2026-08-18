import { Module } from "@nestjs/common";
import { ProviderRegistryService } from "./provider-registry.service";
import { ScopedEnvService } from "./scoped-env.service";
import { ModelCatalogService } from "./model-catalog.service";
import { ProvidersController } from "./providers.controller";
import { ProviderKeyService } from "./provider-key.service";

@Module({
  controllers: [ProvidersController],
  providers: [ProviderRegistryService, ProviderKeyService, ScopedEnvService, ModelCatalogService],
  exports: [ProviderRegistryService, ProviderKeyService, ScopedEnvService, ModelCatalogService],
})
export class ProvidersModule {}
