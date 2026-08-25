import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { HostRouterMiddleware } from "./mcp-platform/host-router.middleware";
import { ScheduleModule } from "@nestjs/schedule";
import { DatabaseModule } from "./shared/database.provider";
// PRIVACY — hard erasure. Narrow by design: changes no agent behaviour.
import { PrivacyModule } from "./privacy/privacy.module";
import { RedisModule } from "./shared/redis.provider";
import { ScopeGuard } from "./auth/scope.guard";
import { RateLimitGuard } from "./auth/rate-limit.guard";
import { HealthModule } from "./health/health.module";
import { ConnectionsModule } from "./connections/connections.module";
import { ToolGatewayModule } from "./tool-gateway/tool-gateway.module";
import { AgentRuntimeModule } from "./agent-runtime/agent-runtime.module";
import { AuthModule } from "./auth/auth.module";
import { ProvidersModule } from "./providers/providers.module";
import { StreamingModule } from "./streaming/streaming.module";
import { MemoryModule } from "./memory/memory.module";
import { MonitoringModule } from "./monitoring/monitoring.module";
import { ObservabilityModule } from "./observability/observability.module";
import { TriggerBridgeModule } from "./trigger-bridge/trigger-bridge.module";
import { SkillsModule } from "./skills/skills.module";
import { EvalsModule } from "./evals/evals.module";
import { OpenApiModule } from "./openapi/openapi.module";
import { McpPlatformModule } from "./mcp-platform/mcp-platform.module";
import { DocsMcpModule } from "./mcp-docs/docs-mcp.module";
import { OAuthModule } from "./oauth/oauth.module";
import { FilesModule } from "./files/files.module";
import { ChannelsModule } from "./channels/channels.module";
import { PerformanceEvidenceMiddleware } from "./performance-evidence/performance-evidence.middleware";
import { PerformanceEvidenceModule } from "./performance-evidence/performance-evidence.module";

const imports = [
  // NestJS built-in task scheduler (powers @Cron in MemorySchedulerService etc.)
  ScheduleModule.forRoot(),

  // Shared providers (global — available to all modules)
  DatabaseModule,
  RedisModule,
  PrivacyModule,

  // Feature modules
  HealthModule,
  AuthModule,
  ProvidersModule,
  ConnectionsModule,
  ToolGatewayModule,
  AgentRuntimeModule,
  StreamingModule,
  MemoryModule,
  MonitoringModule,
  // WIN-133 (M3.1) — the turn-shaped analytical projection and its outbox.
  // Listed here so its startup probe runs on every boot and says out loud
  // whether the sink is disabled, unreachable, or missing its schema.
  ObservabilityModule,
  // PPR-25 + PPR-26 + PPR-51: HMAC internal callback + realtime run bridge
  // + durable-approval wait endpoint live in TriggerBridgeModule.
  TriggerBridgeModule,
  // Theme I.10 — public OpenAPI 3.1 spec + Swagger UI.
  OpenApiModule,
  // Theme S — skills framework + 4 official skills.
  SkillsModule,
  // Theme J — ratings, eval criteria, judge-LLM pipeline, golden-set runner.
  EvalsModule,
  // Theme K — Platform MCP gateway: /mcp/platform + token mint + permission gate.
  McpPlatformModule,
  // Phase 3 — Docs MCP: public, unauthenticated read-only catalog of
  // `content/{docs,guides}/*.md` exposed at `/mcp/docs`. Used by the
  // marketing site's "Talk to Platos" agent + any third-party MCP
  // client wanting to consume Platos product docs.
  DocsMcpModule,
  // Theme K.10 — OAuth 2.1 + Dynamic Client Registration server.
  OAuthModule,
  // PIFSP-16 — File System: 4-level attachment hierarchy explorer.
  FilesModule,
  // Connect reimagining — channels RUNTIME + BRIDGE: inbound webhook doorway,
  // per-connection Chat SDK runtime, Platos bridge (slack/telegram/whatsapp/
  // discord). Management REST lives in AgentRuntimeModule; this is the inbound
  // side that receives provider posts and routes them to a Platos turn.
  ChannelsModule,
  PerformanceEvidenceModule,
];

@Module({
  imports,
  providers: [
    // ScopeGuard applied globally — every request gets org_id + user_id scoping
    { provide: APP_GUARD, useClass: ScopeGuard },
    // RateLimitGuard — per-org rate limiting (60/min, 1000/day, configurable)
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule implements NestModule {
  /**
   * Phase 3b — host-aware MCP routing. Inspect `req.headers.host` and, if
   * it matches the public docs-only subdomain (`mcp.platos.dev`), reject
   * everything except `/mcp/docs*` with 403. See
   * `mcp-platform/host-router.middleware.ts` for rationale.
   *
   * Applied to all routes; the middleware short-circuits with `next()` on
   * non-public hosts so the cost is one Map lookup + one string compare.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(PerformanceEvidenceMiddleware, HostRouterMiddleware).forRoutes("*");
  }
}
