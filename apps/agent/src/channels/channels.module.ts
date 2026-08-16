import { Module } from "@nestjs/common";
import { ChannelsInboundController } from "./channels-inbound.controller";
import { ChannelAppOAuthController } from "./channel-app-oauth.controller";
import { ChannelAppEventsController } from "./channel-app-events.controller";
import {
  ChannelLinkController,
  ChannelLinkService,
} from "./channel-link.controller";
import { ChannelRuntimeService } from "./channel-runtime.service";
import { ChannelPersistenceService } from "./channel-persistence.service";
import { AgentRuntimeModule } from "../agent-runtime/agent-runtime.module";
import { MonitoringModule } from "../monitoring/monitoring.module";

/**
 * Channels RUNTIME + BRIDGE slice — the inbound webhook doorway + per-connection
 * Chat SDK runtime + the Platos bridge (for slack / telegram / whatsapp /
 * discord), PLUS the Connect v3 marketplace channel-app surfaces:
 *   - ChannelAppOAuthController  — Slack OAuth V2 install/callback (public;
 *     CSRF via Redis `state` nonce, in-controller auth — see scope.guard.ts).
 *   - ChannelAppEventsController — the single Slack Events API request URL per
 *     app (public; Slack v0 signature verify + event_id dedupe, hands verified
 *     events to ChannelRuntimeService.handleAppEvent).
 *   - ChannelLinkController / ChannelLinkService — Phase C hosted account
 *     linking (public; single-use Redis nonce + Sign-in-with-Slack OIDC +
 *     userInfo-authoritative claims → verified email identity attach — see
 *     scope.guard.ts allowlist `/api/v1/channels/link/`). ChannelLinkService is
 *     EXPORTED so ChannelRuntimeService can call `linkStart(...)` from the
 *     policy gate / `link` command (item (3)).
 *
 * Dependencies (all via already-exporting feature modules — nothing new
 * provided here except the channel components):
 *   - AgentTaskService     ← AgentRuntimeModule (runs the Platos turn)
 *   - ChannelPersistenceService (clean channel, thread, identity, credential graph)
 *   - MessageCryptoService ← MonitoringModule (Credential envelope boundary)
 *   - PRISMA_TOKEN         ← DatabaseModule (@Global — no import needed)
 *   - REDIS_TOKEN          ← RedisModule (@Global — no import needed)
 *
 * The management surface (channels.controller.ts / channels.* MCP tools) lives
 * in AgentRuntimeModule; it evicts a stale Chat instance after an
 * update/rotate/delete by resolving ChannelRuntimeService lazily
 * (ModuleRef, strict:false — direct DI would be circular) and calling
 * `invalidate(connectionId)`. The 10-min TTL is only the backstop.
 */
@Module({
  imports: [AgentRuntimeModule, MonitoringModule],
  controllers: [
    ChannelsInboundController,
    ChannelAppOAuthController,
    ChannelAppEventsController,
    ChannelLinkController,
  ],
  providers: [ChannelPersistenceService, ChannelRuntimeService, ChannelLinkService],
  exports: [ChannelPersistenceService, ChannelRuntimeService, ChannelLinkService],
})
export class ChannelsModule {}
