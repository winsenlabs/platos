import { Module } from "@nestjs/common";
import { ProviderRegistryService } from "./provider-registry.service";
import { ScopedEnvService } from "./scoped-env.service";
import { ModelCatalogService } from "./model-catalog.service";
import { ProvidersController } from "./providers.controller";
import { SecretsModule } from "../auth/secrets.module";

@Module({
  imports: [SecretsModule],
  controllers: [ProvidersController],
  providers: [ProviderRegistryService, ScopedEnvService, ModelCatalogService],
  exports: [ProviderRegistryService, ScopedEnvService, ModelCatalogService],
})
export class ProvidersModule {}
