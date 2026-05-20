import { Module } from "@nestjs/common";
import { ToolRegistryService } from "./tool-registry.service";
import { ToolExecutorService } from "./tool-executor.service";
import { ToolRouterService } from "./tool-router.service"; // PIFSP-11
import { ToolSyncWsService } from "./tool-sync-ws.service"; // canonical raw-WS service speaking platools protocol
import { SchemaInjectorService } from "./schema-injector.service";
import { MonitoringModule } from "../monitoring/monitoring.module";
// Issue #1 — `MCPPermissionGatewayService` is also exported by
// `McpPlatformModule`, but that module already imports
// `ToolGatewayModule` (for ToolExecutorService). Importing it back
// here would create a circular module graph that has to be broken
// with `forwardRef` on both sides — risky for boot order.
//
// The service is stateless (the only constructor dep is PRISMA_TOKEN,
// which is global via DatabaseModule), so registering it directly as
// a provider here gives ToolExecutorService a working instance via DI
// without any circular wiring. Two instances exist in the DI graph;
// they have identical behaviour because the service holds no state
// between calls.
import { MCPPermissionGatewayService } from "../mcp-platform/permission-gateway.service";

@Module({
  // Importing MonitoringModule makes SpansService (Theme E.1) and
  // ToolAuditService (Theme E.5) available for ToolExecutorService to inject
  // optionally. MonitoringModule has no edges into tool-gateway, so no cycle.
  imports: [MonitoringModule],
  providers: [
    ToolRegistryService,
    ToolExecutorService,
    ToolRouterService,
    ToolSyncWsService,
    SchemaInjectorService,
    // Issue #1 — see import comment above. Local registration avoids
    // a circular import. When the gate is enabled via
    // PLATOS_TOOL_DISPATCH_PERMISSION_GATE=1, ToolExecutorService now
    // has a real `MCPPermissionGatewayService` to inject.
    MCPPermissionGatewayService,
  ],
  exports: [
    ToolRegistryService,
    ToolExecutorService,
    ToolRouterService,
    ToolSyncWsService,
    SchemaInjectorService,
  ],
})
export class ToolGatewayModule {}
