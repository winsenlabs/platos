import { Module } from "@nestjs/common";
import { McpServerRegistryService } from "./server-registry.service";
import { McpToolExecutorService } from "./mcp-tool-executor.service";
import { McpAgentController } from "./mcp-agent.controller";
import { McpPlatformModule } from "../mcp-platform/mcp-platform.module";
import { MonitoringModule } from "../monitoring/monitoring.module";

/**
 * Theme K.6 — Agent MCP registry + per-agent executor.
 *
 * Surface 2: the customer LLM's tool-matrix federation of third-party
 * MCP servers. `McpServerRegistryService` CRUDs `PlatosMCPServer` +
 * `PlatosAgentMCPBinding` + caches `tools/list`. `McpToolExecutorService`
 * runs the permission gate + dispatches per-transport at turn time.
 *
 * Depends on McpPlatformModule for the 4-tier permission gateway and
 * MonitoringModule for ToolAuditService.
 */
@Module({
  imports: [McpPlatformModule, MonitoringModule],
  controllers: [McpAgentController],
  providers: [McpServerRegistryService, McpToolExecutorService],
  exports: [McpServerRegistryService, McpToolExecutorService],
})
export class McpAgentModule {}
