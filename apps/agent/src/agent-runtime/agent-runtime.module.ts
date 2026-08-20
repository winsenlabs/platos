import { Module } from "@nestjs/common";
import { AgentController } from "./agent.controller";
import { PlatosTasksController } from "./platos-tasks.controller";
import { PlatosTaskExecutionController } from "./platos-task-execution.controller";
import { PlatosTaskExecutionService } from "./platos-task-execution.service";
import { ChannelsController } from "./channels.controller";
import { ChannelAppsController } from "./channel-apps.controller";
import { AgentService } from "./agent.service";
import { AgentTaskService } from "./agent-task.service";
import { TurnDispatchService } from "./turn-dispatch.service";
import { AgentCrudService } from "./agent-crud.service";
import { AgentClusterService } from "./agent-cluster.service";
import { PromptBuilderService } from "./prompt-builder.service";
import { AttachmentsService } from "./attachments.service";
import { ToolGatewayModule } from "../tool-gateway/tool-gateway.module";
import { MemoryModule } from "../memory/memory.module";
import { MonitoringModule } from "../monitoring/monitoring.module";
import { ObservabilityModule } from "../observability/observability.module";
import { AuthModule } from "../auth/auth.module";
import { ProvidersModule } from "../providers/providers.module";
import { StreamingModule } from "../streaming/streaming.module";
import { SkillsModule } from "../skills/skills.module";
import { EvalsModule } from "../evals/evals.module";
import { GovernanceModule } from "../governance/governance.module";
import { PromptCacheService } from "./prompt-cache.service";

@Module({
  imports: [
    ToolGatewayModule,
    MemoryModule,
    MonitoringModule,
    // WIN-133 — the DLQ drain endpoint drains the observability outbox too, and
    // the diagnostics endpoint reports its sink health.
    ObservabilityModule,
    AuthModule,
    ProvidersModule,
    StreamingModule,
    // Theme S.6 — AgentService merges skill prompt blocks into the system prompt.
    SkillsModule,
    // Theme J — ratings, eval criteria, judge-LLM pipeline, golden-set runner.
    EvalsModule,
    // PIFSP-18 — PII governance filters (regex + checksum, 4 choke-points).
    GovernanceModule,
    // W.1.2 note — RunsBridgeService (in TriggerBridgeModule) is resolved
    // LAZILY in AgentService via ModuleRef.get() rather than injected,
    // because the transitive cycle
    // AgentService→RunsBridge→ConnectionsGateway→AgentTaskService→AgentService
    // can't be resolved at provider-instantiation time even with
    // forwardRef on module scan. No need to import TriggerBridgeModule
    // here.
  ],
  controllers: [AgentController, PlatosTasksController, PlatosTaskExecutionController, ChannelsController, ChannelAppsController],
  // TurnDispatchService — the durable-vs-direct chokepoint. Exported so the WS
  // gateway (ConnectionsModule), the SSE/REST controller (this module), and the
  // Slack channel (ChannelsModule) all route dispatch through the ONE service
  // that reads executionMode.
  providers: [AgentService, AgentTaskService, TurnDispatchService, AgentCrudService, AgentClusterService, PromptBuilderService, AttachmentsService, PromptCacheService, PlatosTaskExecutionService],
  exports: [AgentService, AgentTaskService, TurnDispatchService, AgentCrudService, AgentClusterService, PromptBuilderService, AttachmentsService, PromptCacheService],
})
export class AgentRuntimeModule {}
