import { Module } from "@nestjs/common";
import { OrganizationService } from "./organization.service";
import { EnvironmentService } from "./environment.service";

/**
 * Theme MCPF-W6 — Admin module.
 *
 * Bundles two services for organization and Environment management:
 *   - `OrganizationService` — list/get/update orgs + member CRUD.
 *   - `EnvironmentService`  — list/create/delete canonical Environments;
 *                              credential management is paused for WIN-124.
 *
 * Both consume the shared canonical Prisma client. Re-exports the services
 * so `McpPlatformModule` can wire them into `buildPlatformToolHandlers`.
 */
@Module({
  providers: [OrganizationService, EnvironmentService],
  exports: [OrganizationService, EnvironmentService],
})
export class AdminModule {}
