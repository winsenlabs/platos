import { Module } from "@nestjs/common";
import { McpServerRegistryService } from "./server-registry.service";
import { McpToolExecutorService } from "./mcp-tool-executor.service";
import { McpCredentialService } from "../tool-gateway/mcp-transport/mcp-credential.service";
import { McpConnectionPool } from "../tool-gateway/mcp-transport/mcp-client-pool.service";
import { McpAgentController } from "./mcp-agent.controller";
import { McpPlatformModule } from "../mcp-platform/mcp-platform.module";
import { MonitoringModule } from "../monitoring/monitoring.module";
import { ProvidersModule } from "../providers/providers.module";

/**
 * Theme K.6 — Agent MCP registry + per-agent executor.
 *
 * Surface 2: the customer LLM's tool-matrix federation of third-party
 * MCP servers. `McpServerRegistryService` CRUDs `PlatosMCPServer` +
 * `PlatosAgentMCPBinding` + caches `tools/list`. `McpToolExecutorService`
 * runs the permission gate + dispatches per-transport at turn time.
 *
 * Depends on McpPlatformModule for the 4-tier permission gateway,
 * MonitoringModule for ToolAuditService, and ProvidersModule for
 * ScopedEnvService (MCP server credential resolution).
 */
@Module({
  imports: [McpPlatformModule, MonitoringModule, ProvidersModule],
  controllers: [McpAgentController],
  providers: [
    McpServerRegistryService,
    McpToolExecutorService,
    McpCredentialService,
    McpConnectionPool,
  ],
  exports: [McpServerRegistryService, McpToolExecutorService],
})
export class McpAgentModule {}
