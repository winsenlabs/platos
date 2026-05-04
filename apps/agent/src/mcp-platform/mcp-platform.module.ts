import { Module, forwardRef } from "@nestjs/common";
import { PlatosMCPTokenService } from "./token.service";
import { MCPPermissionGatewayService } from "./permission-gateway.service";
import { McpEventsService } from "./events.service";
import { McpPlatformController } from "./mcp-platform.controller";
import { McpEntityController } from "./mcp-entity.controller";
import { McpBearerTokenService } from "./mcp-bearer-token.service";
import { McpIdentityResolverService } from "./identity-resolver.service";
import { McpToolAclService } from "./mcp-tool-acl.service";
import { AgentRuntimeModule } from "../agent-runtime/agent-runtime.module";
import { MemoryModule } from "../memory/memory.module";
import { EvalsModule } from "../evals/evals.module";
import { AuthModule } from "../auth/auth.module";
import { ToolGatewayModule } from "../tool-gateway/tool-gateway.module";
import { SkillsModule } from "../skills/skills.module";
import { ProvidersModule } from "../providers/providers.module";
import { MonitoringModule } from "../monitoring/monitoring.module";
import { OAuthModule } from "../oauth/oauth.module";
import { AdminModule } from "../admin/admin.module";

/**
 * Theme K — Platform MCP.
 *
 * Nest DI requires the controller's injected services to be visible
 * through this module's imports. Breakdown:
 *   - AgentRuntimeModule  → AgentCrudService + AgentTaskService
 *   - MemoryModule        → ConversationService + MemoryService + KnowledgeGraphService
 *   - EvalsModule         → RatingService + EvalService
 *   - AuthModule          → AuthService (entities.*)
 *   - ToolGatewayModule   → ToolExecutorService (entities.wire_test)
 *   - SkillsModule        → SkillRegistryService + SkillImporterService (K.7)
 *   - ProvidersModule     → ProviderRegistryService (providers.*)
 *   - MonitoringModule    → CostService + BudgetService + ApprovalsService
 *                            + ToolAuditService + SafetyEventService (K.8)
 *
 * forwardRef on AgentRuntimeModule because McpAgentModule (which depends
 * on us) is in turn imported by AgentRuntimeModule-adjacent flows —
 * keeps Nest's module graph resolution happy.
 */
@Module({
  imports: [
    forwardRef(() => AgentRuntimeModule),
    MemoryModule,
    EvalsModule,
    AuthModule,
    ToolGatewayModule,
    SkillsModule,
    ProvidersModule,
    MonitoringModule,
    // K.10 — accept OAuth-issued bearers (plt_oa_*) on /mcp/platform.
    OAuthModule,
    // MCPF-W6 — Organization + Environment services for the settings/admin tools.
    AdminModule,
  ],
  // PIFSP-21 — McpEntityController lives alongside the platform one;
  // both share OAuthModule + ToolGatewayModule (ToolExecutorService +
  // ToolRouterService).
  controllers: [McpPlatformController, McpEntityController],
  providers: [PlatosMCPTokenService, MCPPermissionGatewayService, McpEventsService, McpBearerTokenService, McpIdentityResolverService, McpToolAclService],
  exports: [PlatosMCPTokenService, MCPPermissionGatewayService, McpEventsService, McpBearerTokenService, McpIdentityResolverService, McpToolAclService],
})
export class McpPlatformModule {}
