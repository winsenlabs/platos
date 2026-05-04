import { Module } from "@nestjs/common";
import { OrganizationService } from "./organization.service";
import { EnvironmentService } from "./environment.service";
import { ProvidersModule } from "../providers/providers.module";

/**
 * Theme MCPF-W6 — Admin module.
 *
 * Bundles two services for org/env/secret management:
 *   - `OrganizationService` — list/get/update orgs + member CRUD.
 *   - `EnvironmentService`  — list/create/delete RuntimeEnvironment +
 *                              SecretStore name/value CRUD.
 *
 * Both consume the shared Prisma client + (in EnvironmentService's case)
 * `ScopedEnvService` for cache invalidation. Re-exports the services so
 * `McpPlatformModule` can wire them into `buildPlatformToolHandlers`.
 */
@Module({
  imports: [ProvidersModule],
  providers: [OrganizationService, EnvironmentService],
  exports: [OrganizationService, EnvironmentService],
})
export class AdminModule {}
