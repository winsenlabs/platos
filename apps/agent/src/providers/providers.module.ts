import { Module } from "@nestjs/common";
import { ProviderRegistryService } from "./provider-registry.service";
import { ScopedEnvService } from "./scoped-env.service";
import { ProvidersController } from "./providers.controller";

@Module({
  controllers: [ProvidersController],
  providers: [ProviderRegistryService, ScopedEnvService],
  exports: [ProviderRegistryService, ScopedEnvService],
})
export class ProvidersModule {}
