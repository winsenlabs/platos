import { Module } from "@nestjs/common";
import { ChannelsInboundController } from "./channels-inbound.controller";
import { ChannelRuntimeService } from "./channel-runtime.service";
import { AgentRuntimeModule } from "../agent-runtime/agent-runtime.module";
import { MemoryModule } from "../memory/memory.module";
import { MonitoringModule } from "../monitoring/monitoring.module";

/**
 * Channels RUNTIME + BRIDGE slice — the inbound webhook doorway + per-connection
 * Chat SDK runtime + the Platos bridge (for slack / telegram / whatsapp /
 * discord).
 *
 * Dependencies (all via already-exporting feature modules — nothing new
 * provided here except the two channel components):
 *   - AgentTaskService     ← AgentRuntimeModule (runs the Platos turn)
 *   - ConversationService  ← MemoryModule (getOrCreateThread / resolveEndUser)
 *   - MessageCryptoService ← MonitoringModule (decrypt connection credentials)
 *   - PRISMA_TOKEN         ← DatabaseModule (@Global — no import needed)
 *
 * The management surface (channels.controller.ts / channels.* MCP tools) lives
 * in AgentRuntimeModule; it evicts a stale Chat instance after an
 * update/rotate/delete by resolving ChannelRuntimeService lazily
 * (ModuleRef, strict:false — direct DI would be circular) and calling
 * `invalidate(connectionId)`. The 10-min TTL is only the backstop.
 */
@Module({
  imports: [AgentRuntimeModule, MemoryModule, MonitoringModule],
  controllers: [ChannelsInboundController],
  providers: [ChannelRuntimeService],
  exports: [ChannelRuntimeService],
})
export class ChannelsModule {}
