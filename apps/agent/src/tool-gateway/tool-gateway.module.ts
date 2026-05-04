import { Module } from "@nestjs/common";
import { ToolRegistryService } from "./tool-registry.service";
import { ToolExecutorService } from "./tool-executor.service";
import { ToolRouterService } from "./tool-router.service"; // PIFSP-11
import { ToolSyncWsService } from "./tool-sync-ws.service"; // canonical raw-WS service speaking platools protocol
import { SchemaInjectorService } from "./schema-injector.service";
import { MonitoringModule } from "../monitoring/monitoring.module";

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
