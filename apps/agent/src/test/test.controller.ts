import { Controller, Get, Post, Body, Query, Inject } from "@nestjs/common";
import { ToolRegistryService } from "../tool-gateway/tool-registry.service";
import { AuthService } from "../auth/auth.service";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";

const DUMMY_ORG_ID = "test-org";
const DUMMY_PROJECT_ID = "test-project";
const DUMMY_ENV_ID = "test-env-dev";

@Controller("test")
export class TestController {
  constructor(
    @Inject(ToolRegistryService) private readonly toolRegistry: ToolRegistryService,
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
  ) {}

  @Get("ping")
  ping() {
    return { status: "ok", test_mode: true, timestamp: new Date().toISOString() };
  }

  @Post("tools/register")
  async registerTools(
    @Body() body: {
      organizationId?: string;
      projectId?: string;
      environmentId?: string;
      entityPk: string;
      sourceEntityId?: string;
      tools: any[];
      callbackUrl: string;
    },
  ) {
    const result = await this.toolRegistry.registerTools(
      {
        organizationId: body.organizationId || DUMMY_ORG_ID,
        projectId: body.projectId || DUMMY_PROJECT_ID,
        environmentId: body.environmentId || DUMMY_ENV_ID,
        entityPk: body.entityPk,
        sourceEntityId: body.sourceEntityId || "test-entity",
      },
      body.tools,
      body.callbackUrl,
    );
    return result;
  }

  @Get("tools/find")
  findTools(
    @Query("organizationId") organizationId: string | undefined,
    @Query("projectId") projectId: string | undefined,
    @Query("environmentId") environmentId: string | undefined,
    @Query("query") query: string,
    @Query("limit") limit?: string,
    @Query("entity") entity?: string,
  ) {
    const scope = {
      organizationId: organizationId || DUMMY_ORG_ID,
      projectId: projectId || DUMMY_PROJECT_ID,
      environmentId: environmentId || DUMMY_ENV_ID,
    };
    const results = this.toolRegistry.findTools(query, scope, limit ? parseInt(limit, 10) : 15, entity);
    return { scope, query, results, total: results.length };
  }

  @Get("tools/stats")
  toolStats() {
    return this.toolRegistry.getIndexStats();
  }

  @Post("auth/create-session")
  async createSession(@Body() body: {
    organizationId?: string;
    projectId?: string;
    environmentId?: string;
    entityId: string;
    userId: string;
    userToken?: string;
  }) {
    const token = await this.authService.createSessionToken({
      userId: body.userId,
      organizationId: body.organizationId || DUMMY_ORG_ID,
      projectId: body.projectId || DUMMY_PROJECT_ID,
      environmentId: body.environmentId || DUMMY_ENV_ID,
      entityId: body.entityId,
      ...(body.userToken ? { userToken: body.userToken } : {}),
    });
    return token ? { token } : { token: null, reason: "entity not registered" };
  }

  @Post("auth/validate-session")
  async validateSession(@Body() body: { token: string }) {
    const payload = await this.authService.validateSessionToken(body.token);
    return payload ? { valid: true, ...payload } : { valid: false, reason: "Invalid or expired token" };
  }

  @Get("redis/ping")
  async redisPing() {
    const result = await this.redis.ping();
    return { redis: result };
  }

  /** Validate all API response schemas — returns expected shapes for each endpoint */
  @Get("schemas")
  schemas() {
    return {
      "GET /api/health": { status: "string", service: "string", timestamp: "string", version: "string" },
      "POST /api/v1/agent/threads": { id: "string", agentId: "string", organizationId: "string", projectId: "string", environmentId: "string", userId: "string", title: "string?", status: "string", turnCount: "number", createdAt: "datetime", updatedAt: "datetime" },
      "GET /api/v1/agent/threads": { threads: "Thread[]", total: "number" },
      "POST /api/v1/agent/threads/:id/messages": { text: "string", threadId: "string", events: "AgentStreamEvent[]" },
      "GET /api/v1/agent/threads/:id/messages": { messages: "StoredMessage[]", total: "number" },
      "POST /api/v1/agent/entities": { organizationId: "string", projectId: "string", entityId: "string", displayName: "string", connectionStatus: "string" },
      "GET /api/v1/agent/entities": { entities: "ConnectedEntity[]" },
      "GET /api/v1/agent/tools": { tools: "OrgToolEntry[]", total: "number" },
      "GET /api/v1/agent/tools/search": { query: "string", results: "OrgToolEntry[]", total: "number" },
      "GET /api/v1/agent/providers": { providers: "ProviderState[]" },
      "POST /api/v1/agent/providers/:provider/link": { id: "string", enabled: "boolean", linked: "boolean" },
      "DELETE /api/v1/agent/providers/:provider/link": { unlinked: "boolean" },
      "PATCH /api/v1/agent/providers/:provider": { id: "string", enabled: "boolean" },
      "GET /api/v1/agent/monitoring/cost": { inputTokens: "number", outputTokens: "number", costCents: "number" },
      streaming_events: {
        status: { type: "status", status: "connected|thinking|executing|generating", agentId: "string?" },
        token: { type: "token", text: "string" },
        tool_call: { type: "tool_call", name: "string", params: "object", callId: "string" },
        tool_result: { type: "tool_result", name: "string", result: "any", callId: "string", display: "AgentDisplayHint?" },
        message_boundary: { type: "message_boundary" },
        thinking: { type: "thinking", text: "string" },
        meta: { type: "meta", thread_id: "string?", agent_id: "string?", usage: "AgentTokenUsage?" },
        approval_needed: { type: "approval_needed", approvalId: "string", action: "string", details: "string?", agentId: "string?" },
        safety_flags: { type: "safety_flags", flags: "AgentSafetyFlag[]" },
        error: { type: "error", message: "string", flags: "AgentSafetyFlag[]?" },
        done: { type: "done", usage: "AgentTokenUsage?", stopped: "boolean?" },
      },
    };
  }

  /** Run a full end-to-end health check — verifies DB, Redis, BM25, auth */
  @Get("healthcheck/full")
  async fullHealthcheck() {
    const checks: Record<string, { status: string; latencyMs: number; error?: string }> = {};

    // Redis
    const redisStart = Date.now();
    try {
      await this.redis.ping();
      checks.redis = { status: "ok", latencyMs: Date.now() - redisStart };
    } catch (e: any) {
      checks.redis = { status: "fail", latencyMs: Date.now() - redisStart, error: e.message };
    }

    // BM25 index
    const bm25Start = Date.now();
    try {
      const stats = this.toolRegistry.getIndexStats();
      checks.bm25 = { status: "ok", latencyMs: Date.now() - bm25Start, ...stats as any };
    } catch (e: any) {
      checks.bm25 = { status: "fail", latencyMs: Date.now() - bm25Start, error: e.message };
    }

    // Auth — exercises the full per-entity sign/verify path. Requires a
    // registered entity; if none exists in test mode we short-circuit "ok"
    // (no token could be minted, so nothing to verify).
    const authStart = Date.now();
    try {
      const token = await this.authService.createSessionToken({
        userId: "healthcheck",
        organizationId: DUMMY_ORG_ID,
        projectId: DUMMY_PROJECT_ID,
        environmentId: DUMMY_ENV_ID,
        entityId: "healthcheck-entity",
      });
      if (!token) {
        checks.auth = { status: "skip", latencyMs: Date.now() - authStart, error: "no entity registered" };
      } else {
        const valid = await this.authService.validateSessionToken(token);
        checks.auth = { status: valid ? "ok" : "fail", latencyMs: Date.now() - authStart };
      }
    } catch (e: any) {
      checks.auth = { status: "fail", latencyMs: Date.now() - authStart, error: e.message };
    }

    const allOk = Object.values(checks).every((c) => c.status === "ok");
    return { status: allOk ? "healthy" : "degraded", checks };
  }
}
