import { Module } from "@nestjs/common";
import { ToolRegistryService } from "./tool-registry.service";
import { ToolExecutorService } from "./tool-executor.service";
import { ToolRouterService } from "./tool-router.service"; // PIFSP-11
import { ToolSyncWsService } from "./tool-sync-ws.service"; // canonical raw-WS service speaking platools protocol
import { SchemaInjectorService } from "./schema-injector.service";
// mcp-transport — the two Phase-1 primitives relocated onto the entity dispatch
// path (design Commit 2). Independent of PlatosMCPServer; consumed by the
// forthcoming mcpDispatch branch in ToolExecutorService (Commit 4).
import { McpCredentialService } from "./mcp-transport/mcp-credential.service";
import { McpConnectionPool } from "./mcp-transport/mcp-client-pool.service";
// EntityMcpDiscoveryService (design Commit 3) — outbound tools/list for
// connectionKind=="mcp" entities, registering into the shared tool matrix once
// per project environment. Depends on ToolRegistryService + the two relocated
// mcp-transport primitives, all providers of this same module.
import { EntityMcpDiscoveryService } from "./mcp-transport/entity-mcp-discovery.service";
// Periodic discovery refresh sweep (design Commit 5 / §5) — re-discovers stale
// connectionKind=="mcp" entities on a cron tick. Needs the @Global() PRISMA +
// REDIS providers (single-flight lock) and EntityMcpDiscoveryService, all in
// scope here. ScheduleModule.forRoot() is registered once in AppModule, so the
// @Cron decorator is picked up without importing ScheduleModule locally.
import { EntityMcpDiscoverySchedulerService } from "./mcp-transport/entity-mcp-discovery-scheduler.service";
import { MonitoringModule } from "../monitoring/monitoring.module";
// ProvidersModule exports ScopedEnvService, which McpCredentialService injects
// to resolve linked Credential references used by `{{secret}}`. ProvidersModule imports
// nothing back into tool-gateway, so no circular module graph.
import { ProvidersModule } from "../providers/providers.module";
// WIN-269 (M4.3) — THE IMPORT THAT USED TO STAND HERE IS GONE.
//
// This module used to import `MCPPermissionGatewayService` out of
// `../mcp-platform` and register a SECOND instance of it locally, under a
// comment explaining that importing `McpPlatformModule` back would make the
// MODULE graph circular. The comment was right about the module graph and
// silent about the FILE graph: the import itself was the tool->MCP half of the
// tool↔MCP cycle, and it survived because nothing measured it.
//
// `ToolExecutorService` now injects `TOOL_PERMISSION_GATEWAY`, the port this
// area owns (`tool-permission.port.ts`), and
// `mcp-platform/mcp-port-bindings.module.ts` — `@Global()` for exactly
// this reason — binds the token to `MCPPermissionGatewayService`. The running
// binary and the stdio app both resolve ONE instance of it, and this module
// imports nothing from mcp-platform. `scripts/arch/agent-area-cycles.mjs`
// fails if the edge comes back.

@Module({
  // Importing MonitoringModule makes SpansService (Theme E.1) and
  // ToolAuditService (Theme E.5) available for ToolExecutorService to inject
  // optionally. MonitoringModule has no edges into tool-gateway, so no cycle.
  imports: [MonitoringModule, ProvidersModule],
  providers: [
    ToolRegistryService,
    ToolExecutorService,
    ToolRouterService,
    ToolSyncWsService,
    SchemaInjectorService,
    McpCredentialService,
    McpConnectionPool,
    EntityMcpDiscoveryService,
    EntityMcpDiscoverySchedulerService,
  ],
  exports: [
    ToolRegistryService,
    ToolExecutorService,
    ToolRouterService,
    ToolSyncWsService,
    SchemaInjectorService,
    McpCredentialService,
    McpConnectionPool,
    EntityMcpDiscoveryService,
  ],
})
export class ToolGatewayModule {}
