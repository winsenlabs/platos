import { Module, forwardRef } from "@nestjs/common";
import { RunsBridgeService } from "./runs-bridge.service";
import { InternalExecuteToolController } from "./internal-execute-tool.controller";
import { TriggerSchedulesService } from "./schedules.service";
import { ToolGatewayModule } from "../tool-gateway/tool-gateway.module";
import { ConnectionsModule } from "../connections/connections.module";
import { ProvidersModule } from "../providers/providers.module";
import { AgentRuntimeModule } from "../agent-runtime/agent-runtime.module";

/**
 * Bridge module between Platos agent and Trigger.dev.
 *
 * - RunsBridgeService: subscribes to trigger runs, forwards events to Socket.IO
 * - InternalExecuteToolController: HMAC-signed callback endpoint for trigger tasks
 *   to execute org tools (PPR-25 wiring — dispatches via ToolExecutorService)
 * - TriggerSchedulesService: programmatic schedule CRUD wrapping the SDK
 *
 * PPR-26: imports ConnectionsModule so RunsBridgeService can forward
 * trigger.dev realtime updates into the matching thread's Socket.IO room.
 */
@Module({
  // EOBD.39 — ProvidersModule gives the InternalExecuteToolController
  // access to ScopedEnvService.invalidate().
  // W.1 — AgentRuntimeModule (forwardRef in case of future cycles) gives
  // InternalExecuteToolController access to AgentTaskService for the
  // per-batch-item `/internal/batch-turn` endpoint.
  imports: [
    ToolGatewayModule,
    // ConnectionsModule imported directly — cycle to AgentRuntimeModule
    // was severed by hotfix #2 which moved RunsBridge lookup from
    // AgentService's constructor to a lazy ModuleRef.get() at call time.
    // No forwardRef needed now; ConnectionsGateway export is visible at
    // provider-instantiation time.
    ConnectionsModule,
    ProvidersModule,
    // AgentRuntimeModule still forwardRef'd — TriggerBridgeModule is
    // imported transitively from ConnectionsModule→AgentRuntimeModule,
    // so the import lookup order here still benefits from deferred
    // resolution.
    forwardRef(() => AgentRuntimeModule),
  ],
  controllers: [InternalExecuteToolController],
  providers: [RunsBridgeService, TriggerSchedulesService],
  exports: [RunsBridgeService, TriggerSchedulesService],
})
export class TriggerBridgeModule {}
