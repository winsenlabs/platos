import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  Inject,
  Optional,
  HttpException,
  HttpStatus,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { type Request, type Response } from "express";
import * as crypto from "node:crypto";
import { ConversationService } from "../memory/conversation.service";
import { AgentTaskService } from "./agent-task.service";
import { withHeartbeat } from "../shared/async-heartbeat";
import { AgentService } from "./agent.service";
import { ToolRegistryService } from "../tool-gateway/tool-registry.service";
import { ToolSyncWsService } from "../tool-gateway/tool-sync-ws.service";
import { AuthService } from "../auth/auth.service";
import { StreamingService } from "../streaming/streaming.service";
import { CostService } from "../monitoring/cost.service";
import { SpansService } from "../monitoring/spans.service";
import { TraceService } from "../monitoring/trace.service";
import { UtilizationService } from "../monitoring/utilization.service";
import { ToolAuditService } from "../monitoring/tool-audit.service";
import { MonitoringApprovalsService } from "../monitoring/approvals.service";
import { ToolExecutorService } from "../tool-gateway/tool-executor.service";
import { ProviderHealthService } from "../auth/provider-health.service";
import { ProviderRegistryService } from "../providers/provider-registry.service";
import { SecretsService } from "../auth/secrets.service";
import { AgentCrudService, type CreateAgentDto, type UpdateAgentDto } from "./agent-crud.service";
import { AgentClusterService } from "./agent-cluster.service";
import {
  PromptBuilderService,
  type PromptBlock,
  DEFAULT_CATEGORY_DESCRIPTIONS,
} from "./prompt-builder.service";
import { SkillRuntimeService } from "../skills/skill-runtime.service";
import type { RequestScope } from "../auth/scope.guard";
import { requireOperator } from "../auth/scope.guard";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import { BudgetService, type BudgetPeriod, type BudgetScopeType } from "../monitoring/budget.service";
import { SafetyEventService, type DetectorKind, type DetectorAction } from "../monitoring/safety-event.service";
import { GovernanceService } from "../monitoring/governance.service";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { approvalRedisKey } from "../monitoring/approval-keys";
import { RatingService } from "../evals/rating.service";
import {
  CriterionService,
  type CreateCriterionDto,
  type UpdateCriterionDto,
} from "../evals/criterion.service";
import { EvalService, SelfEvaluationError } from "../evals/eval.service";
import {
  GoldenSetService,
  type CreateGoldenSetDto,
  type UpdateGoldenSetDto,
} from "../evals/golden-set.service";
import { env } from "../shared/env";

/**
 * Agent REST API — every endpoint calls real services.
 * All queries scoped by (organizationId, projectId, environmentId, userId) from ScopeGuard.
 */
@Controller("api/v1/agent")
export class AgentController {
  constructor(
    private readonly conversationService: ConversationService,
    private readonly agentTaskService: AgentTaskService,
    private readonly agentService: AgentService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly toolSync: ToolSyncWsService,
    private readonly authService: AuthService,
    private readonly streamingService: StreamingService,
    private readonly costService: CostService,
    private readonly spansService: SpansService,
    private readonly traceService: TraceService,
    private readonly utilizationService: UtilizationService,
    private readonly toolAuditService: ToolAuditService,
    private readonly approvalsService: MonitoringApprovalsService,
    private readonly toolExecutor: ToolExecutorService,
    private readonly providerHealth: ProviderHealthService,
    private readonly providerRegistry: ProviderRegistryService,
    private readonly secretsService: SecretsService,
    private readonly agentCrud: AgentCrudService,
    private readonly promptBuilder: PromptBuilderService,
    // Theme H — governance + budget + safety event services.
    private readonly budgetService: BudgetService,
    private readonly safetyEventService: SafetyEventService,
    private readonly governanceService: GovernanceService,
    private readonly messageCrypto: MessageCryptoService,
    // Theme J — ratings + eval pipeline.
    private readonly ratingService: RatingService,
    private readonly criterionService: CriterionService,
    private readonly evalService: EvalService,
    private readonly goldenSetService: GoldenSetService,
    // PPR-10 — shared Redis client for the replay rate-limit token bucket.
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    // RG.1.5 — optional SkillRuntimeService for retrieval-block resolution
    // in the playground preview endpoint. Absent in test harnesses; when
    // missing, retrieval blocks fail-open to empty per PromptBuilder policy.
    // PRA-AC — cluster management
    private readonly clusterService: AgentClusterService,
    // RG.1.5 — optional SkillRuntimeService (must come last — optional params follow required)
    @Optional() private readonly skillRuntime?: SkillRuntimeService,
  ) {}

  private getScope(req: Request): RequestScope {
    return (
      (req as any).scope || {
        organizationId: "unknown",
        projectId: "unknown",
        environmentId: "unknown",
        userId: "unknown",
      }
    );
  }

  private scopeTuple(scope: RequestScope) {
    return {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
  }

  /**
   * SECURITY (audit C2) — durable-exec internal callbacks are admin-token
   * gated, but the whole body (incl. `scope`) is attacker-controllable if the
   * shared static admin token is reached (e.g. via the shared Trigger enqueue
   * surface). As a non-breaking mitigation, verify the body's agentId +
   * threadId actually BELONG to the body's scope — a forged foreign scope
   * won't own the real target ids. Legitimate callbacks (the chat-session /
   * durable-turn workers) always send a scope that owns its ids, so this is a
   * no-op for them. Full defense-in-depth = HMAC over the body with a
   * worker-held secret (tracked as the C2 HMAC follow-up).
   */
  private async adminCallbackScopeOwns(body: {
    agentId?: string;
    threadId?: string | null;
    scope?: { organizationId?: string; projectId?: string; environmentId?: string };
  }): Promise<boolean> {
    const s = body?.scope;
    if (!s?.organizationId || !s?.projectId || !s?.environmentId) return false;
    // FAIL CLOSED — an attacker could otherwise forge a victim scope and OMIT
    // both ids to skip every check (Fable verify BLOCKER B). Require at least
    // one verifiable ownership anchor.
    if (!body.agentId && !body.threadId) return false;
    if (body.agentId) {
      const agent = await this.agentCrud
        .findById(body.agentId, body.scope as any)
        .catch(() => null);
      if (!agent) return false;
    }
    if (body.threadId) {
      const thread = await this.conversationService
        .getThread(body.threadId, body.scope as any, { allUsers: true })
        .catch(() => null);
      if (!thread) return false;
    }
    return true;
  }

  /**
   * LAUNCH-3 — parse the optional `X-Platos-Config` header. Whitelist of
   * fields safe to override per-request; ignore anything else. 8KB cap on
   * the raw header value to avoid abuse. Returns undefined when header is
   * missing, malformed, or empty after whitelisting.
   *
   * Allowed keys: model, maxSteps, contextLimit, historyMode,
   * agentRetryConfig. Adding new keys requires adding both here AND in
   * `agent-task.service.ts:executeStreamingTurn` where the override applies.
   */
  private parsePlatosConfigHeader(req: Request): Record<string, unknown> | undefined {
    const raw = req.headers["x-platos-config"];
    if (!raw || typeof raw !== "string") return undefined;
    if (raw.length > 8192) return undefined;
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { return undefined; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

    const out: Record<string, unknown> = {};
    if (typeof parsed.model === "string" && parsed.model.length < 200) out.model = parsed.model;
    if (Number.isFinite(parsed.maxSteps) && parsed.maxSteps >= 1 && parsed.maxSteps <= 100) {
      out.maxSteps = Math.floor(parsed.maxSteps);
    }
    if (Number.isFinite(parsed.contextLimit) && parsed.contextLimit >= 1 && parsed.contextLimit <= 1000) {
      out.contextLimit = Math.floor(parsed.contextLimit);
    }
    if (parsed.historyMode === "compact" || parsed.historyMode === "rolling") {
      out.historyMode = parsed.historyMode;
    }
    if (parsed.agentRetryConfig === null) {
      out.agentRetryConfig = null;
    } else if (parsed.agentRetryConfig && typeof parsed.agentRetryConfig === "object" && Array.isArray(parsed.agentRetryConfig.rules)) {
      out.agentRetryConfig = parsed.agentRetryConfig;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** PIFSP-20: fire-and-forget Redis publish for thread lifecycle events. */
  private publishThreadLifecycle(payload: Record<string, unknown>): void {
    this.redis.publish("thread:lifecycle", JSON.stringify(payload)).catch(() => undefined);
  }

  // ═══════════════════════════════════════════════════════
  // Threads
  // ═══════════════════════════════════════════════════════

  @Post("threads")
  async createThread(
    @Req() req: Request,
    @Body() body: { agentId?: string; title?: string },
  ) {
    const scope = this.getScope(req);

    // Reject missing or sentinel "default" agentId. SDK consumers were
    // previously able to slip past with no agentId on the body (the
    // legacy `body.agentId || "default"` fell through to a literal
    // string "default" agent), creating threads stuck on the bare
    // "You are a helpful AI assistant" config forever — the runtime
    // resolver downstream had no way to recover the real agent later
    // because the thread's `agentId` column was permanently "default".
    // Failing fast here is the only place that can prevent the stuck
    // state.
    const agentId = (body.agentId ?? "").trim();
    if (!agentId || agentId.toLowerCase() === "default") {
      throw new HttpException(
        {
          error:
            "agentId is required when creating a thread. Pass the id of an agent from /agents in this scope.",
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Forward visitor identity (lifted from JWT userMeta by ScopeGuard) so
    // the PlatosEndUser row gets created with the visitor's actual name +
    // email instead of just the hashed `lead-<hash>`. Without this, the
    // EndUser row stays anonymous forever even when the entity backend
    // signed `userMeta: { name, email }` into the session token, AND the
    // prompt's auto-resolved sessionContext (which reads from the EndUser
    // row) has nothing to inject for `{{user.name}}` / `{{user.email}}`.
    const userMeta = (scope.sessionContext as { user?: { name?: string; email?: string } } | null | undefined)?.user;
    const thread = await this.conversationService.createThread(
      scope,
      agentId,
      body.title,
      userMeta && (userMeta.name || userMeta.email)
        ? { displayName: userMeta.name, email: userMeta.email }
        : undefined,
    );
    return thread;
  }

  @Get("threads")
  async listThreads(
    @Req() req: Request,
    @Query("agentId") agentId?: string,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    // Theme F.10 — metadata filters. `pinned` + `archived` accept "true"/"1";
    // `archived=only` short-circuits to archived-only. `tag` takes a single
    // string normalised server-side.
    @Query("tag") tag?: string,
    @Query("pinned") pinned?: string,
    @Query("archived") archived?: string,
    // Operator view: skip userId filter, return all threads in scope.
    @Query("allUsers") allUsers?: string,
  ) {
    const scope = this.getScope(req);
    const pinnedFlag = pinned === "true" || pinned === "1" ? true : undefined;
    let archivedFlag: boolean | "only" | undefined;
    if (archived === "only") archivedFlag = "only";
    else if (archived === "true" || archived === "1") archivedFlag = true;
    else archivedFlag = undefined; // default — hide archived
    return this.conversationService.listThreads(scope, {
      agentId,
      status,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      tag,
      pinned: pinnedFlag,
      archived: archivedFlag,
      allUsers: allUsers === "true" || allUsers === "1",
    });
  }

  @Get("threads/:threadId")
  async getThread(
    @Req() req: Request,
    @Param("threadId") threadId: string,
    // Operator view: open any thread in-scope, not just the caller's own.
    // Mirrors GET /threads?allUsers so the detail matches the list.
    @Query("allUsers") allUsers?: string,
  ) {
    const scope = this.getScope(req);
    const thread = await this.conversationService.getThread(threadId, scope, {
      allUsers: allUsers === "true" || allUsers === "1",
    });
    if (!thread) return { error: "Thread not found", status: 404 };
    return thread;
  }

  @Patch("threads/:threadId")
  async updateThread(
    @Req() req: Request,
    @Param("threadId") threadId: string,
    @Body() body: { title?: string; status?: string },
  ) {
    const scope = this.getScope(req);
    return this.conversationService.updateThread(threadId, scope, body);
  }

  /**
   * PIFSP-20 — soft delete (archive). Never hard-deletes.
   * Hard purge is admin-tier only via admin MCP tools (K.18).
   */
  @Delete("threads/:threadId")
  async deleteThread(@Req() req: Request, @Param("threadId") threadId: string) {
    const scope = this.getScope(req);
    const result = await this.conversationService.deleteThread(threadId, scope);
    if (result.archived) {
      this.publishThreadLifecycle({
        type: "thread.archived",
        threadId,
        archivedAt: result.archivedAt,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        // SECURITY (audit H4 regression) — the owner left the scope room, so
        // fan lifecycle out to their user room too, else their conversation
        // list stops updating live for non-open threads.
        userId: scope.userId,
      });
    }
    return result;
  }

  /** PIFSP-20 — rename a thread (1-200 chars). */
  @Patch("threads/:threadId/rename")
  async renameThread(
    @Req() req: Request,
    @Param("threadId") threadId: string,
    @Body() body: { title: string | null },
  ) {
    const scope = this.getScope(req);
    const result = await this.conversationService.renameThread(threadId, scope, body.title ?? null);
    if (!result) throw new NotFoundException({ error: "Thread not found in scope", threadId });
    this.publishThreadLifecycle({
      type: "thread.renamed",
      threadId,
      title: result.title,
      updatedAt: result.updatedAt,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      // SECURITY (audit H4 regression) — fan out to the owner's user room.
      userId: scope.userId,
    });
    return result;
  }

  // ═══════════════════════════════════════════════════════
  // Theme F.10 — thread metadata (tags, pin, archive)
  //
  // All four endpoints are idempotent + scope-gated by the underlying
  // service: a mismatched scope surfaces as "not found" (fail closed) and
  // never leaks the existence of the row to another tenant.
  // ═══════════════════════════════════════════════════════

  /**
   * Replace the thread's tag list. Empty array clears all tags.
   * Tags are normalised server-side (lowercase / trim / dedupe).
   */
  @Post("threads/:threadId/tags")
  async setTags(
    @Req() req: Request,
    @Param("threadId") threadId: string,
    @Body() body: { tags: string[] },
  ) {
    const scope = this.getScope(req);
    if (!body || !Array.isArray(body.tags)) {
      return { error: "tags must be an array of strings", status: 400 };
    }
    try {
      const thread = await this.conversationService.setThreadTags(
        threadId,
        scope,
        body.tags,
      );
      return thread;
    } catch (err: any) {
      return { error: err?.message || "Failed to set tags", status: 400 };
    }
  }

  /**
   * Toggle pin state. Body `{ pinned }` optional — omit to flip the
   * current value. Present? Forces the thread to that state.
   */
  @Post("threads/:threadId/pin")
  async togglePin(
    @Req() req: Request,
    @Param("threadId") threadId: string,
    @Body() body: { pinned?: boolean } = {},
  ) {
    const scope = this.getScope(req);
    try {
      const thread = await this.conversationService.togglePin(
        threadId,
        scope,
        typeof body?.pinned === "boolean" ? body.pinned : undefined,
      );
      return thread;
    } catch (err: any) {
      return { error: err?.message || "Failed to toggle pin", status: 400 };
    }
  }

  /**
   * Archive a thread (soft — sets `archivedAt`). Re-archiving refreshes
   * the timestamp. Archive ≠ delete — Theme F.10 hard-constraint §4.
   */
  @Post("threads/:threadId/archive")
  async archiveThread(@Req() req: Request, @Param("threadId") threadId: string) {
    const scope = this.getScope(req);
    try {
      const thread = await this.conversationService.archiveThread(threadId, scope);
      this.publishThreadLifecycle({
        type: "thread.archived",
        threadId,
        archivedAt: (thread as any).archivedAt?.toISOString?.() ?? null,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        // SECURITY (audit H4 regression) — fan out to the owner's user room.
        userId: scope.userId,
      });
      return thread;
    } catch (err: any) {
      return { error: err?.message || "Failed to archive thread", status: 400 };
    }
  }

  /** Clear `archivedAt`, returning the thread to the default list. */
  @Post("threads/:threadId/unarchive")
  async unarchiveThread(@Req() req: Request, @Param("threadId") threadId: string) {
    const scope = this.getScope(req);
    try {
      const thread = await this.conversationService.unarchiveThread(threadId, scope);
      this.publishThreadLifecycle({
        type: "thread.unarchived",
        threadId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        // SECURITY (audit H4 regression) — fan out to the owner's user room.
        userId: scope.userId,
      });
      return thread;
    } catch (err: any) {
      return { error: err?.message || "Failed to unarchive thread", status: 400 };
    }
  }

  // ═══════════════════════════════════════════════════════
  // Messages
  // ═══════════════════════════════════════════════════════

  @Post("threads/:threadId/messages")
  async sendMessage(
    @Req() req: Request,
    @Param("threadId") threadId: string,
    @Body() body: { message: string; agentId?: string; attachmentIds?: string[] },
  ) {
    const scope = this.getScope(req);
    const result = await this.agentTaskService.executeNonStreamingTurn(
      body.message, scope, { threadId, agentId: body.agentId, attachmentIds: body.attachmentIds },
    );
    return result;
  }

  @Get("threads/:threadId/messages")
  async getMessages(
    @Req() req: Request,
    @Param("threadId") threadId: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    // Operator view: read messages of any in-scope thread (see getThread).
    @Query("allUsers") allUsers?: string,
  ) {
    const scope = this.getScope(req);
    return this.conversationService.getMessages(threadId, scope, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      allUsers: allUsers === "true" || allUsers === "1",
    });
  }

  // ═══════════════════════════════════════════════════════
  // PRA-TC — thread replies
  // ═══════════════════════════════════════════════════════

  /** PRA-TC.7a: fetch all sub-thread replies for a given parent message. */
  @Get("threads/:threadId/messages/:messageId/replies")
  async getMessageReplies(
    @Req() req: Request,
    @Param("threadId") threadId: string,
    @Param("messageId") messageId: string,
  ) {
    const scope = this.getScope(req);
    return this.conversationService.getThreadReplies(threadId, messageId, scope);
  }

  /** PRA-TC.7b: batch reply counts for a set of message IDs (comma-separated). */
  @Get("threads/:threadId/reply-counts")
  async getReplyCounts(
    @Req() req: Request,
    @Param("threadId") threadId: string,
    @Query("messageIds") messageIds: string,
  ) {
    const scope = this.getScope(req);
    const ids = (messageIds ?? "").split(",").filter(Boolean);
    const counts = await this.conversationService.batchGetReplyCounts(ids, threadId, scope);
    return Object.fromEntries(counts);
  }

  // ═══════════════════════════════════════════════════════
  // Theme F — fork / edit+rerun / retry
  // ═══════════════════════════════════════════════════════

  /**
   * Fork a thread at a specific message.
   *
   * The new thread shares history through `upToMessageId` (inclusive) and
   * inherits the parent's scope — every row carries the same (org, project,
   * env) tuple per the Theme A invariant + Theme F §5.1.
   */
  @Post("threads/:threadId/fork")
  async forkThread(
    @Req() req: Request,
    @Param("threadId") threadId: string,
    @Body() body: { upToMessageId: string; title?: string },
  ) {
    const scope = this.getScope(req);
    if (!body?.upToMessageId) {
      return { error: "upToMessageId required", status: 400 };
    }
    try {
      const fork = await this.conversationService.forkThread(threadId, scope, {
        upToMessageId: body.upToMessageId,
        title: body.title,
      });
      return fork;
    } catch (err: any) {
      return { error: err?.message || "Fork failed", status: 400 };
    }
  }

  /**
   * Edit a user message + rerun the agent from there.
   *
   * Soft-deletes N+ messages (status="edited_out") so the immutable audit
   * trail is preserved — never mutates history (Theme F invariant §5.2).
   * Returns the new user message row; the caller then initiates a fresh
   * streaming turn to regenerate the assistant response.
   */
  @Post("threads/:threadId/messages/:messageId/edit-and-rerun")
  async editAndRerun(
    @Req() req: Request,
    @Param("threadId") threadId: string,
    @Param("messageId") messageId: string,
    @Body() body: { content: string },
  ) {
    const scope = this.getScope(req);
    if (typeof body?.content !== "string" || body.content.length === 0) {
      return { error: "content required (non-empty string)", status: 400 };
    }
    try {
      const updated = await this.conversationService.editAndRerun(
        threadId,
        messageId,
        scope,
        body.content,
      );
      return { message: updated };
    } catch (err: any) {
      return { error: err?.message || "Edit failed", status: 400 };
    }
  }

  /**
   * Retry an assistant turn with (optionally) different model or temperature.
   *
   * Soft-deletes the target + any subsequent messages and returns the
   * preceding user message so the caller can re-stream. Per Theme F §1, the
   * callers that pass `model` or `temperature` hints should include them in
   * the subsequent send-message call; this endpoint itself only rewinds.
   */
  @Post("threads/:threadId/messages/:messageId/retry")
  async retryAssistant(
    @Req() req: Request,
    @Param("threadId") threadId: string,
    @Param("messageId") messageId: string,
  ) {
    const scope = this.getScope(req);
    try {
      const res = await this.conversationService.retryAssistantTurn(
        threadId,
        messageId,
        scope,
      );
      return res;
    } catch (err: any) {
      return { error: err?.message || "Retry failed", status: 400 };
    }
  }

  // ═══════════════════════════════════════════════════════
  // Theme F.9 — thread artifacts (list for the chat UI panel)
  // ═══════════════════════════════════════════════════════

  /**
   * List the artifacts produced in a thread. One row per `artifactKey`
   * (the latest revision) so the chat UI's artifact panel has one entry
   * per logical artifact; `revisionCount` exposes the history depth.
   *
   * Scope-gated via `conversationService.listThreadArtifacts` — a
   * mismatched scope surfaces as 404 with no tenancy leak.
   */
  @Get("threads/:threadId/artifacts")
  async listThreadArtifacts(
    @Req() req: Request,
    @Param("threadId") threadId: string,
    @Query("limit") limit?: string,
  ) {
    const scope = this.getScope(req);
    try {
      const artifacts = await this.conversationService.listThreadArtifacts(
        threadId,
        scope,
        { limit: limit ? parseInt(limit, 10) : undefined },
      );
      return { artifacts };
    } catch (err: any) {
      return { error: err?.message || "Failed to list artifacts", status: 404 };
    }
  }

  // ═══════════════════════════════════════════════════════
  // SSE Streaming
  // ═══════════════════════════════════════════════════════

  @Post("threads/:threadId/stream")
  async streamMessage(
    @Req() req: Request,
    @Res() res: Response,
    @Param("threadId") threadId: string,
    @Body() body: {
      message: string;
      agentId?: string;
      dynamicBlocks?: Record<string, string>;
      attachmentIds?: string[];
      /**
       * Theme F — per-turn system prompt override. Applies ONLY to this
       * turn; does not mutate the agent's stored systemPrompt.
       */
      systemPromptOverride?: string | null;
      /**
       * Theme F.5 — per-turn output schema (JSON Schema object). When set,
       * the runtime routes through Vercel AI SDK's `streamObject`, validates
       * the model output against the schema, and retries once with the
       * validation errors fed back on failure. Wins over the agent's
       * `outputSchema`.
       */
      outputSchema?: Record<string, unknown>;
      /**
       * Per-request model routing label. Selects a named route from the agent's
       * `modelRoutes` config (e.g. "alpha", "bravo", "fast"). Falls back to the
       * default route when omitted. No-op when the agent has no `modelRoutes`.
       */
      modelLabel?: string;
    },
  ) {
    const scope = this.getScope(req);
    // EOBD.26 W10-review follow-up — SSE clients previously had no
    // cancellation path at all; only the turn timeout stopped the
    // stream. Now the controller creates an AbortController and
    // wires `req.on("close")` + `res.on("close")` to abort so a
    // client disconnect (tab close, navigation, network drop) aborts
    // the LLM stream immediately.
    const ac = new AbortController();
    const onClose = () => {
      if (!ac.signal.aborted) ac.abort();
    };
    req.on("close", onClose);
    res.on("close", onClose);
    const rawEvents = this.agentTaskService.executeStreamingTurn(
      body.message,
      scope,
      {
        threadId,
        agentId: body.agentId,
        dynamicBlocks: body.dynamicBlocks,
        attachmentIds: body.attachmentIds,
        systemPromptOverride: body.systemPromptOverride ?? null,
        outputSchema: body.outputSchema,
        modelLabel: body.modelLabel,
        abortSignal: ac.signal,
        idempotencyKey:
          (req.headers["idempotency-key"] as string | undefined) ||
          (req.headers["Idempotency-Key"] as string | undefined),
      },
    );
    // EOBD.106 — wrap SSE output in the heartbeat merger so a 30-60s
    // reverse-proxy idle timeout can't close the stream while a tool
    // is running. Socket.IO callers don't need this — their transport
    // already ships ping/pong. 15s interval, override via
    // PLATOS_STREAM_HEARTBEAT_MS. Validated in `shared/env.ts`.
    const heartbeatMs = Math.max(1000, env.PLATOS_STREAM_HEARTBEAT_MS ?? 15_000);
    const events = withHeartbeat(rawEvents, {
      intervalMs: heartbeatMs,
      signal: ac.signal,
    });
    await this.streamingService.streamToSSE(events, res);
  }

  // ═══════════════════════════════════════════════════════
  // Approvals (HITL)
  // ═══════════════════════════════════════════════════════

  /**
   * PPR-51 — resolve a durable HITL approval. The `request_durable_approval`
   * meta-tool mints a trigger.dev waitpoint token and stores `durableToken`
   * in the emitted `approval_needed` payload; the UI POSTs the approved /
   * rejected decision here, which completes the waitpoint via the
   * `completeWaitToken` helper. The trigger.dev task (`platos-agent-durable-
   * approval-wait`) resumes and returns `{ approved, comment, respondedBy }`
   * to the waiting agent turn.
   *
   * Scope-gate: the controller is behind ScopeGuard, so the caller's scope
   * is already validated. We additionally thread `respondedBy` = scope.userId
   * through the waitpoint payload so the audit row stays truthful.
   */
  @Post("durable-approvals/:token/resolve")
  async resolveDurableApproval(
    @Req() req: Request,
    @Param("token") token: string,
    @Body() body: { approved: boolean; comment?: string; approvalId?: string },
  ) {
    const scope = this.getScope(req);
    // EOBD.13 follow-up — symmetry with resolveApproval: if an approvalId
    // is supplied, reject cross-scope upfront so clients get a structured
    // 404 rather than a silent ledger no-op.
    if (body.approvalId) {
      const found = await this.approvalsService.getById(
        this.scopeTuple(scope),
        body.approvalId,
      );
      if (!found) {
        throw new NotFoundException({
          error: "Approval not found in this scope",
          approvalId: body.approvalId,
        });
      }
    }
    // Lazy-load the trigger integration helper so the controller still
    // boots when the trigger.dev SDK env isn't configured.
    const { getTriggerConfig, completeWaitToken } = await import("./trigger-integration");
    const cfg = getTriggerConfig();
    if (!cfg) {
      // EOBD.13 review follow-up — 503 is the right status for a feature
      // that's simply not configured on this deployment.
      throw new ServiceUnavailableException({
        resolved: false,
        error: "trigger.dev not configured on this agent — durable approvals disabled",
      });
    }
    try {
      await completeWaitToken(cfg, token, {
        approved: !!body.approved,
        comment: body.comment ?? null,
        respondedBy: scope.userId,
        respondedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      return { resolved: false, error: err?.message || "Failed to complete waitpoint" };
    }
    // Mirror the approvals ledger so the dashboard transitions immediately —
    // the task's own `approvalsService.resolve` call is idempotent so this
    // is a safe double-write. Only applied when the caller knew the
    // approvalId (the UI learns it from the `approval_needed` event).
    if (body.approvalId) {
      await this.approvalsService.resolve({
        scope: this.scopeTuple(scope),
        approvalId: body.approvalId,
        status: body.approved ? "approved" : "rejected",
        respondedBy: scope.userId,
        comment: body.comment,
      });
    }
    return { resolved: true, token, approved: !!body.approved };
  }

  @Post("approvals/:approvalId/resolve")
  async resolveApproval(
    @Req() req: Request,
    @Param("approvalId") approvalId: string,
    @Body()
    body: {
      approved: boolean;
      comment?: string;
      /**
       * MCP approval-UI Wave 2 — when present and the call is approved,
       * the operator-edited args replace the LLM-proposed args at
       * execution time. Must be a JSON object; arrays / scalars are
       * rejected.
       */
      editedArgs?: Record<string, unknown>;
    },
  ) {
    const scope = this.getScope(req);
    // EOBD.13 — scope-gate the rpush. Previously the controller only
    // verified scope on the ledger write; the Redis push was global,
    // so a caller in scope A who knew a scope-B approvalId could wake
    // scope B's agent blpop with a forged resolve. Now check ownership
    // first, then push to a scope-namespaced Redis key (EOBD.15).
    const scopeTuple = this.scopeTuple(scope);
    const found = await this.approvalsService.getById(scopeTuple, approvalId);
    if (!found) {
      // EOBD.13 review follow-up — return 404 with structured body so
      // client-side error handling can distinguish success from scope
      // rejection without body-peeking.
      throw new NotFoundException({ error: "Approval not found in this scope", approvalId });
    }
    // SECURITY (audit H5) — only the REQUESTER or an operator may resolve.
    // Scope-gating alone let any same-scope user (incl. anonymous guest)
    // approve another user's destructive gated tool call, or reject to DoS it.
    // Fail CLOSED when requestedBy is null (userless context — MCP token with
    // no minter, or a system/background turn): only an operator may resolve.
    // A non-operator must have a concrete requestedBy that matches their own
    // userId — a null requester must never match a null/undefined scope.userId.
    if (
      scope.principal !== "operator" &&
      ((found as any).requestedBy == null ||
        (found as any).requestedBy !== scope.userId)
    ) {
      throw new ForbiddenException({
        error: "Only the requesting user or an operator may resolve this approval",
        approvalId,
      });
    }
    // Wave 2 — validate editedArgs early. Reject malformed shapes
    // before any side effects (Redis push or ledger write). Also
    // ignore stray editedArgs on a rejection so a malicious client
    // can't sneak edits in via the no-op path.
    let validatedEditedArgs: Record<string, unknown> | undefined;
    if (body.approved && body.editedArgs !== undefined && body.editedArgs !== null) {
      if (
        typeof body.editedArgs !== "object" ||
        Array.isArray(body.editedArgs)
      ) {
        throw new BadRequestException({
          error: "editedArgs must be a JSON object",
          approvalId,
        });
      }
      validatedEditedArgs = body.editedArgs;
    }
    const payload = JSON.stringify({
      approved: !!body.approved,
      comment: body.comment,
      respondedBy: scope.userId,
      respondedAt: new Date().toISOString(),
      // Wave 2 — surface the edited-args presence on the Redis wake
      // payload so any future runtime branch (e.g. waitpoint flow that
      // wants to react to edits) can see the marker without re-reading
      // the DB row.
      ...(validatedEditedArgs ? { editedArgsApplied: true } : {}),
    });
    const redisKey = approvalRedisKey(scopeTuple, approvalId);
    await (this.agentService as any).redis.rpush(redisKey, payload);
    await (this.agentService as any).redis.expire(redisKey, 60); // cleanup
    // Persist the transition to the governance ledger (Theme E.6). Best-effort
    // — a resolve on a non-existent / already-resolved approval is a no-op in
    // the service.
    await this.approvalsService.resolve({
      scope: scopeTuple,
      approvalId,
      status: body.approved ? "approved" : "rejected",
      respondedBy: scope.userId,
      comment: body.comment,
      ...(validatedEditedArgs
        ? {
            editedArgs: validatedEditedArgs,
            editedByUserId: scope.userId,
          }
        : {}),
    });
    // Broadcast the resolution to every chat tab subscribed to the scope's
    // approval feed. Without this, a second tab (or the same tab after a
    // reconnect) keeps showing the modal in "pending" state.
    await (this.agentService as any).redis
      .publish(
        "approval:event",
        JSON.stringify({
          type: "approval_resolved",
          approvalId,
          status: body.approved ? "approved" : "rejected",
          respondedBy: scope.userId,
          // SECURITY (audit H4 regression) — route the resolution to the
          // REQUESTER's user room, not just the operator scope room. The
          // requester left the scope room, so without their userId the
          // resolved-broadcast never reaches their approval card (spinner
          // stuck on operator-resolves-on-behalf).
          userId: (found as any).requestedBy ?? null,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        }),
      )
      .catch(() => {});
    return {
      resolved: true,
      approvalId,
      approved: !!body.approved,
      ...(validatedEditedArgs ? { editedArgsApplied: true } : {}),
    };
  }

  // ═══════════════════════════════════════════════════════
  // Agent CRUD
  // ═══════════════════════════════════════════════════════

  @Post("agents")
  async createAgent(@Req() req: Request, @Body() body: CreateAgentDto) {
    const scope = this.getScope(req);
    return this.agentCrud.create(scope, body);
  }

  @Get("agents")
  async listAgents(@Req() req: Request) {
    const scope = this.getScope(req);
    const agents = await this.agentCrud.list(scope);
    return { agents, total: agents.length };
  }

  @Get("agents/:agentId")
  async getAgent(@Req() req: Request, @Param("agentId") agentId: string) {
    const scope = this.getScope(req);
    const agent = await this.agentCrud.findById(agentId, scope);
    if (!agent) return { error: "Agent not found", status: 404 };
    return agent;
  }

  /**
   * PIFSP-1 — Non-streaming chat for a specific agent.
   * Session token may carry agentId claim; ScopeGuard enforces path match.
   */
  @Post("agents/:agentId/messages")
  async agentMessages(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Body() body: {
      message: string;
      threadId?: string;
      attachmentIds?: string[];
      outputSchema?: Record<string, unknown>;
      systemPromptOverride?: string | null;
      /** Per-request model routing label. See agentConfig.modelRoutes. */
      modelLabel?: string;
    },
  ) {
    const scope = { ...this.getScope(req), agentId };
    const agentConfigOverride = this.parsePlatosConfigHeader(req);
    const result = await this.agentTaskService.executeNonStreamingTurn(
      body.message,
      scope,
      {
        threadId: body.threadId,
        agentId,
        attachmentIds: body.attachmentIds,
        ...(body.systemPromptOverride !== undefined ? { systemPromptOverride: body.systemPromptOverride } : {}),
        modelLabel: body.modelLabel,
        ...(agentConfigOverride ? { agentConfigOverride } : {}),
      },
    );
    return result;
  }

  /**
   * PIFSP-1 — SSE streaming chat for a specific agent.
   * Streams AgentStreamEvents as server-sent events with 15s heartbeat.
   */
  @Get("agents/:agentId/chat/stream")
  async agentChatStream(
    @Req() req: Request,
    @Res() res: Response,
    @Param("agentId") agentId: string,
    @Query("message") message: string,
    @Query("threadId") threadId?: string,
    @Query("attachmentIds") attachmentIdsRaw?: string,
  ) {
    if (!message) {
      res.status(400).json({ error: "message query param required" });
      return;
    }
    const scope = { ...this.getScope(req), agentId };
    const ac = new AbortController();
    const onClose = () => { if (!ac.signal.aborted) ac.abort(); };
    req.on("close", onClose);
    res.on("close", onClose);
    const attachmentIds = attachmentIdsRaw ? attachmentIdsRaw.split(",").filter(Boolean) : undefined;
    const agentConfigOverride = this.parsePlatosConfigHeader(req);
    const rawEvents = this.agentTaskService.executeStreamingTurn(
      message,
      scope,
      {
        threadId,
        agentId,
        attachmentIds,
        abortSignal: ac.signal,
        ...(agentConfigOverride ? { agentConfigOverride } : {}),
      },
    );
    const heartbeatMs = Math.max(1000, env.PLATOS_STREAM_HEARTBEAT_MS ?? 15_000);
    const events = withHeartbeat(rawEvents, { intervalMs: heartbeatMs, signal: ac.signal });
    await this.streamingService.streamToSSE(events, res);
  }

  /**
   * Theme CTX.6 — per-tool param resolution for the "Tools" tab.
   *
   * Walks the scoped tool matrix, runs the 4-tier resolver (constant /
   * session-override / auto-match / LLM) against the agent's `contextMapping`
   * JSON, and returns a row per (tool, param) with the resolution source.
   * The frontend drives enable toggles + per-param override dropdowns off
   * this payload — no need to re-derive mapping logic client-side.
   */
  @Get("agents/:agentId/tool-mappings")
  async getAgentToolMappings(
    @Req() req: Request,
    @Param("agentId") agentId: string,
  ) {
    const scope = this.getScope(req);
    // Scope-gate the agent load before touching the tool matrix. Keeps the
    // endpoint from leaking per-tool metadata to anyone who can guess an
    // agent id in a foreign scope.
    const agent = await this.agentCrud.findById(agentId, scope);
    if (!agent) {
      throw new NotFoundException({ error: "Agent not found", agentId });
    }
    const { resolveToolMappings } = await import("./context-automap.service");
    const { normalizeContextMapping } = await import("./context-resolver");
    const mapping = normalizeContextMapping(
      (agent as { contextMapping?: unknown }).contextMapping ?? null,
    );
    const ctxRaw = (agent as { contextMapping?: unknown }).contextMapping ?? null;

    // Pull the full matrix + health so the UI can render the same summary
    // row it gets from `/tools/matrix` — saves a second RTT on tab load.
    // Pass agentId so linkedAgentIds allow-list filter runs — UI and
    // runtime find_tools now show exactly the same tool set.
    const tools = this.toolRegistry.getScopedTools(this.scopeTuple(scope), {
      enabledOnly: false,
      agentId,
    });
    const healthRows: Array<{
      toolId: string;
      entityId: string;
      environmentId: string;
      lastStatus: string | null;
    }> = await (this.agentService as any).prisma.platosToolHealth.findMany({
      where: { environmentId: scope.environmentId },
    });
    const healthByKey = new Map<string, string | null>();
    for (const h of healthRows) {
      healthByKey.set(`${h.toolId}:${h.entityId}`, h.lastStatus);
    }

    const rows = tools.map((t) => {
      const resolved = resolveToolMappings(
        { name: t.toolName, inputSchema: t.paramSchema },
        {
          contextMapping:
            // Hand the RAW JSON to the CTX.6 resolver — it reads the extended
            // shape (`_auto`, `_global`, `constants`). The normalized form
            // above is only for logging the declaredKeys summary.
            (ctxRaw as any) ?? undefined,
        },
        null,
      );
      const mapped = resolved.params.filter(
        (p) => p.resolution.source !== "llm",
      ).length;
      return {
        toolName: t.toolName,
        sourceEntity: t.sourceEntityId,
        enabled: t.enabled,
        health: healthByKey.get(`${t.toolId}:${t.entityPk}`) ?? "unknown",
        params: resolved.params,
        mapped,
        total: resolved.params.length,
        warnings: resolved.warnings,
      };
    });
    return {
      tools: rows,
      declaredKeys: mapping?.declaredKeys ?? [],
      agentId,
      total: rows.length,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * TL.3 — per-agent category description editor support.
   *
   * Returns the list of tool categories currently visible to this agent
   * (after `toolsBlockConfig.enabledCategories` filtering), each with its
   * count, the hardcoded default description, and any user override. The
   * Tools tab uses this to drive a "one textarea per category" editor —
   * the textarea prefill = userDescription ?? defaultDescription so the
   * operator sees the baseline and can tweak inline. Empty/unset means
   * "use the default at render time" (the prompt-builder already handles
   * the fallback).
   */
  @Get("agents/:agentId/categories")
  async getAgentCategories(
    @Req() req: Request,
    @Param("agentId") agentId: string,
  ) {
    const scope = this.getScope(req);
    const agent = await this.agentCrud.findById(agentId, scope);
    if (!agent) {
      throw new NotFoundException({ error: "Agent not found", agentId });
    }
    const tlb = (agent as { toolsBlockConfig?: any }).toolsBlockConfig ?? null;
    const enabledCategories: string[] | null = Array.isArray(
      tlb?.enabledCategories,
    )
      ? tlb.enabledCategories
      : null;
    const userOverrides: Record<string, { description?: string }> =
      tlb?.categoryDescriptions && typeof tlb.categoryDescriptions === "object"
        ? tlb.categoryDescriptions
        : {};

    const tools = this.toolRegistry.getScopedTools(this.scopeTuple(scope), {
      enabledOnly: true,
    });
    const allow =
      enabledCategories == null ? null : new Set(enabledCategories);
    const byCategory = new Map<string, number>();
    for (const t of tools) {
      const cat = t.category || "entity";
      if (allow && !allow.has(cat)) continue;
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
    }
    // Merge in any user-override keys that no longer appear in the
    // matrix so the UI can still surface (and edit/clear) orphan entries.
    for (const id of Object.keys(userOverrides)) {
      if (!byCategory.has(id)) byCategory.set(id, 0);
    }
    const categories = Array.from(byCategory.entries())
      .map(([id, count]) => ({
        id,
        count,
        defaultDescription: DEFAULT_CATEGORY_DESCRIPTIONS[id] ?? "",
        userDescription:
          typeof userOverrides[id]?.description === "string"
            ? (userOverrides[id]!.description as string)
            : null,
      }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

    return {
      agentId,
      categories,
      enabledCategories,
      fetchedAt: new Date().toISOString(),
    };
  }

  @Patch("agents/:agentId")
  async updateAgent(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Body() body: UpdateAgentDto,
  ) {
    const scope = this.getScope(req);
    return this.agentCrud.update(agentId, scope, body);
  }

  @Delete("agents/:agentId")
  async deleteAgent(@Req() req: Request, @Param("agentId") agentId: string) {
    const scope = this.getScope(req);
    const deleted = await this.agentCrud.delete(agentId, scope);
    return { deleted };
  }

  // ═══════════════════════════════════════════════════════
  // Theme G — Agent lifecycle (versions, rollback, canary, flags)
  // ═══════════════════════════════════════════════════════

  /**
   * List saved versions of an agent, newest first.
   *
   * PPR-44 — paginated. `?cursor=<id>` walks older pages; `?take=N` selects
   * the page size (default 50, max 200). The response carries `nextCursor`
   * for the UI to request the next page. `total` is intentionally omitted —
   * computing it on top of pagination is an expensive COUNT on a growing
   * table with no user-visible value. Callers that need a full count can
   * raise it as a separate request.
   */
  @Get("agents/:agentId/versions")
  async listAgentVersions(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Query("cursor") cursor?: string,
    @Query("take") take?: string,
  ) {
    const scope = this.getScope(req);
    try {
      const parsedTake = take ? Number.parseInt(take, 10) : undefined;
      const result = await this.agentCrud.listVersions(agentId, scope, {
        cursor: cursor || null,
        take: Number.isFinite(parsedTake) ? parsedTake : undefined,
      });
      return {
        versions: result.versions,
        nextCursor: result.nextCursor,
        pageSize: result.versions.length,
      };
    } catch (err: any) {
      return { error: err?.message || "List versions failed", status: 404 };
    }
  }

  /** Fetch a single version — used by diff + rollback confirmation. */
  @Get("agents/:agentId/versions/:versionId")
  async getAgentVersion(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Param("versionId") versionId: string,
  ) {
    const scope = this.getScope(req);
    const version = await this.agentCrud.getVersion(agentId, versionId, scope);
    if (!version) return { error: "Version not found", status: 404 };
    return version;
  }

  /** Roll back to an older version. See AgentCrudService.rollbackToVersion. */
  @Post("agents/:agentId/versions/:versionId/rollback")
  async rollbackAgentVersion(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Param("versionId") versionId: string,
  ) {
    const scope = this.getScope(req);
    try {
      const agent = await this.agentCrud.rollbackToVersion(agentId, versionId, scope);
      return { agent };
    } catch (err: any) {
      return { error: err?.message || "Rollback failed", status: 400 };
    }
  }

  /**
   * Canary routing config. Body: `{ canaryVersionId: string | null, canaryPercent: number }`.
   * Passing `canaryPercent: 0` disables routing (clears both fields).
   */
  @Patch("agents/:agentId/canary")
  async setAgentCanary(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Body() body: { canaryVersionId?: string | null; canaryPercent?: number },
  ) {
    const scope = this.getScope(req);
    try {
      const agent = await this.agentCrud.setCanary(agentId, scope, {
        canaryVersionId: body.canaryVersionId ?? null,
        canaryPercent: body.canaryPercent ?? 0,
      });
      return { agent };
    } catch (err: any) {
      return { error: err?.message || "Canary update failed", status: 400 };
    }
  }

  /**
   * Theme G.6 — canary metrics side-by-side.
   * Returns cost / latency / error rate grouped by `version_id` (the value
   * AgentTaskService stamps into `PlatosAgentMessage.responseJson`).
   * Default window: last 24h. Max: 720h (30d).
   */
  @Get("agents/:agentId/canary/metrics")
  async getAgentCanaryMetrics(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Query("hours") hoursRaw?: string,
  ) {
    const scope = this.getScope(req);
    const hours = hoursRaw ? parseInt(hoursRaw, 10) : undefined;
    try {
      return await this.agentCrud.getCanaryMetrics(agentId, scope, {
        hours: isNaN(hours as number) ? undefined : hours,
      });
    } catch (err: any) {
      return { error: err?.message || "Canary metrics failed", status: 400 };
    }
  }

  /** Feature flags — replace the whole map. */
  @Patch("agents/:agentId/feature-flags")
  async setAgentFeatureFlags(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Body() body: { featureFlags?: Record<string, boolean> },
  ) {
    const scope = this.getScope(req);
    try {
      const agent = await this.agentCrud.setFeatureFlags(
        agentId,
        scope,
        body.featureFlags || {},
      );
      return { agent };
    } catch (err: any) {
      // EOBD.104 — surface unknown-key errors as a structured 400.
      if (err?.code === "unknown_feature_flag") {
        return {
          error: err.message,
          code: err.code,
          unknownKeys: err.unknownKeys,
          status: 400,
        };
      }
      return { error: err?.message || "Feature flags update failed", status: 400 };
    }
  }

  /**
   * EOBD.104 — feature-flag registry introspection. Lists every known
   * flag + default + description so the webapp editor can render a
   * typed form + reject unknown inputs before they reach setFeatureFlags.
   */
  @Get("feature-flags")
  async listFeatureFlags() {
    const { listFeatureFlags } = await import("../shared/feature-flag-registry");
    return { featureFlags: listFeatureFlags() };
  }

  /**
   * EOBD.105 — promote canary version to current.
   * Atomically: currentVersionId → canaryId, canaryVersionId → null,
   * canaryPercent → 0. Safer than a manual rollback-then-setCanary
   * sequence (which briefly exposes the OLD current version while
   * the canary is already disabled).
   */
  @Post("agents/:agentId/canary/promote")
  async promoteAgentCanary(@Req() req: Request, @Param("agentId") agentId: string) {
    const scope = this.getScope(req);
    try {
      const agent = await this.agentCrud.promoteCanary(agentId, scope);
      return { agent };
    } catch (err: any) {
      return { error: err?.message || "Canary promotion failed", status: 400 };
    }
  }

  // ═══════════════════════════════════════════════════════
  // Providers — env-var linking (Theme B.7)
  // ═══════════════════════════════════════════════════════

  /** List all known LLM providers with current-scope link + env-ready state. */
  @Get("providers")
  async listProviders(@Req() req: Request) {
    const scope = this.getScope(req);
    const providers = await this.providerRegistry.list(this.scopeTuple(scope));
    return { providers };
  }

  /** Models the model picker should show — providers that are enabled + envReady. */
  @Get("providers/models")
  async availableModels(@Req() req: Request) {
    const scope = this.getScope(req);
    return this.providerRegistry.availableModels(this.scopeTuple(scope));
  }

  /** Run a live health probe across every manifest provider. */
  @Get("providers/health")
  async checkProviderHealth(@Req() req: Request) {
    const scope = this.getScope(req);
    return this.providerHealth.testAllProviders(this.scopeTuple(scope));
  }

  /** Live health probe for a single provider. */
  @Get("providers/:provider/health")
  async testProvider(@Req() req: Request, @Param("provider") provider: string) {
    const scope = this.getScope(req);
    return this.providerHealth.testProvider(this.scopeTuple(scope), provider);
  }

  /** Enable a provider in the current scope (upsert). */
  @Post("providers/:provider/link")
  async linkProvider(@Req() req: Request, @Param("provider") provider: string) {
    const scope = this.getScope(req);
    return this.providerRegistry.link(this.scopeTuple(scope), provider);
  }

  /** Remove the enabled row (reverts to default envReady behavior). */
  @Delete("providers/:provider/link")
  async unlinkProvider(@Req() req: Request, @Param("provider") provider: string) {
    const scope = this.getScope(req);
    await this.providerRegistry.unlink(this.scopeTuple(scope), provider);
    return { unlinked: true };
  }

  /** Toggle the enabled flag without deleting the link row. */
  @Patch("providers/:provider")
  async toggleProvider(
    @Req() req: Request,
    @Param("provider") provider: string,
    @Body() body: { enabled: boolean },
  ) {
    const scope = this.getScope(req);
    return this.providerRegistry.setEnabled(this.scopeTuple(scope), provider, body.enabled);
  }

  /** Get connection details for integrating a custom frontend */
  @Get("connect")
  connectionDetails(@Req() req: Request) {
    const scope = this.getScope(req);
    const wsUrl = env.PLATOS_AGENT_WS_URL || `ws://localhost:${env.PLATOS_AGENT_PORT ?? 3100}`;
    const httpUrl = env.PLATOS_AGENT_HTTP_URL || `http://localhost:${env.PLATOS_AGENT_PORT ?? 3100}`;
    return {
      websocket: {
        url: `${wsUrl}/agent`,
        auth: {
          method: "handshake",
          example: `io("${wsUrl}/agent", { auth: { organizationId: "${scope.organizationId}", projectId: "${scope.projectId}", environmentId: "${scope.environmentId}", userId: "<user_id>" } })`,
        },
        events: {
          send: "message",
          receive: "agent_event",
          types: ["token", "tool_call", "tool_result", "message_boundary", "thinking", "meta", "error", "done"],
        },
      },
      rest: {
        baseUrl: `${httpUrl}/api/v1/agent`,
        auth: {
          headers: {
            "X-Platos-Organization-Id": scope.organizationId,
            "X-Platos-Project-Id": scope.projectId,
            "X-Platos-Environment-Id": scope.environmentId,
            "X-Platos-User-Id": "<user_id>",
          },
          alternative: "X-Platos-Session-Token header with signed JWT",
        },
      },
      toolSync: {
        url: `${wsUrl}/tools/sync`,
        auth: `new WebSocket("${wsUrl}/tools/sync?entity=<entity_id>&env=<env>", { headers: { Authorization: "Bearer <service_secret>" } })`,
      },
    };
  }

  // ═══════════════════════════════════════════════════════
  // Tools
  // ═══════════════════════════════════════════════════════

  @Get("tools")
  listTools(@Req() req: Request, @Query("category") category?: string) {
    const scope = this.getScope(req);
    const tools = this.toolRegistry.getScopedTools(this.scopeTuple(scope));
    const filtered = category
      ? tools.filter((t) => t.category === category)
      : tools;
    return { tools: filtered, total: filtered.length };
  }

  @Get("tools/search")
  searchTools(
    @Req() req: Request,
    @Query("q") query: string,
    @Query("limit") limit?: string,
    @Query("entity") sourceEntityId?: string,
  ) {
    const scope = this.getScope(req);
    const results = this.toolRegistry.findTools(
      query, this.scopeTuple(scope), limit ? parseInt(limit, 10) : 15, sourceEntityId,
    );
    return { query, results, total: results.length };
  }

  @Get("tools/stats")
  toolStats() {
    return this.toolRegistry.getIndexStats();
  }

  /**
   * Rich tool matrix for `/agent-tools` UI — joins registry entries with
   * PlatosToolHealth so the UI gets 7-column rows without hitting the DB
   * per tool from the loader. Theme B.8.
   */
  @Get("tools/matrix")
  async toolMatrix(@Req() req: Request) {
    const scope = this.getScope(req);
    const tools = this.toolRegistry.getScopedTools(this.scopeTuple(scope), {
      enabledOnly: false,
    });

    const healthRows = await (this.agentService as any).prisma.platosToolHealth.findMany({
      where: { environmentId: scope.environmentId },
    });
    const healthByKey = new Map<string, any>();
    for (const h of healthRows as Array<{
      toolId: string;
      entityId: string;
      environmentId: string;
      lastStatus: string | null;
      failCount: number;
      totalCalls: number;
      totalFailures: number;
      avgLatencyMs: number | null;
      p95LatencyMs: number | null;
      lastCalledAt: Date | null;
      updatedAt: Date;
    }>) {
      healthByKey.set(`${h.toolId}:${h.entityId}`, h);
    }

    return {
      environmentId: scope.environmentId,
      rows: tools.map((t) => {
        const health = healthByKey.get(`${t.toolId}:${t.entityPk}`);
        return {
          toolId: t.toolId,
          toolName: t.toolName,
          description: t.description,
          // TL.1 — always emit a string so downstream (TL.2 display modes,
          // TL.3 category UI, TL.5 Tools tab) never has to guard for null.
          // Falls back to "uncategorized" when neither the SDK nor the
          // inference chain produced a value.
          category: t.category ?? "uncategorized",
          paramSchema: t.paramSchema,
          entityId: t.sourceEntityId,
          entityPk: t.entityPk,
          callbackUrl: t.callbackUrl,
          enabled: t.enabled,
          health: {
            lastStatus: health?.lastStatus ?? null,
            failCount: health?.failCount ?? 0,
            totalCalls: health?.totalCalls ?? 0,
            totalFailures: health?.totalFailures ?? 0,
            avgLatencyMs: health?.avgLatencyMs ?? null,
            p95LatencyMs: health?.p95LatencyMs ?? null,
            lastCalledAt: health?.lastCalledAt?.toISOString?.() ?? null,
          },
        };
      }),
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * PPR-33 — enable/disable a single tool mapping for (entityId, toolName)
   * within the current scope. The registry writes directly to
   * PlatosEntityToolMapping.enabled (scope-safe) and mirrors into the
   * in-process cache so next-turn tool enumeration reflects the change.
   */
  @Patch("tools/:entityId/:toolName/enabled")
  async setToolEnabled(
    @Req() req: Request,
    @Param("entityId") entityId: string,
    @Param("toolName") toolName: string,
    @Body() body: { enabled: boolean },
  ) {
    const scope = this.getScope(req);
    const updated = await this.toolRegistry.setToolEnabled(
      this.scopeTuple(scope),
      entityId,
      toolName,
      !!body.enabled,
    );
    if (!updated) {
      return { error: "Tool mapping not found for this scope", status: 404 };
    }
    return { ok: true, entityId, toolName, enabled: !!body.enabled };
  }

  /**
   * PPR-33 — UI "Test" button. Invokes the tool with an empty arg payload
   * through the regular ToolExecutorService so the full scope + HMAC path is
   * exercised. `purpose: "ui_test"` stamps the audit row so ops can filter
   * these calls out of production analytics.
   */
  @Post("tools/execute")
  async executeTool(
    @Req() req: Request,
    @Body() body: { tool: string; params?: Record<string, unknown>; purpose?: string },
  ): Promise<any> {
    const scope = this.getScope(req);
    if (!body?.tool) {
      return { error: "tool name required", status: 400 };
    }
    const result = await this.toolExecutor.execute(
      {
        tool: body.tool,
        params: body.params ?? {},
        purpose: body.purpose ?? "ui_test",
      },
      scope,
      { source: "wire_test" },
    );
    return result;
  }

  /**
   * PIFSP-4 Deliverable 6 — Postman-style test dispatch.
   *
   * Looks up the tool by its toolId (PlatosEntityToolMapping.id), validates
   * params against the tool's paramSchema, then fires an HMAC-signed HTTP
   * POST to the entity's callbackUrl with the caller-supplied test headers
   * prepended. Tags the audit row with `source: "dashboard-test"`.
   *
   * Rate-limited 20 req/min per user per scope.
   *
   * Must be declared BEFORE `@Post("tools/execute")` would conflict, but
   * after it in file order — NestJS resolves `:toolId` to a route param, not
   * a literal, so the literal `execute` route above wins for that path.
   */
  @Post("tools/:toolId/test")
  async testTool(
    @Req() req: Request,
    @Param("toolId") toolId: string,
    @Body()
    body: {
      sourceEntityId?: string;
      headers?: Record<string, string>;
      params?: Record<string, unknown>;
    },
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: unknown;
    durationMs: number;
    error?: string;
    upstreamStatus?: number;
  }> {
    const scope = this.getScope(req);

    // Rate limit: 20 req/min per user per scope.
    try {
      const bucketKey =
        `rl:tool-test:${scope.organizationId}:${scope.projectId}:` +
        `${scope.environmentId}:${scope.userId || "anon"}`;
      const count = await this.redis.incr(bucketKey);
      if (count === 1) await this.redis.expire(bucketKey, 60);
      if (count > 20) {
        throw new HttpException(
          { error: "Rate limit exceeded for tool test", limit: 20, retryAfter: 60 },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      // Redis down → fail open.
    }

    // Find the tool in the registry by toolId.
    const allTools = this.toolRegistry.getScopedTools(this.scopeTuple(scope), {
      enabledOnly: false,
    });
    const toolEntry = allTools.find((t) => t.toolId === toolId);
    if (!toolEntry) {
      throw new HttpException(
        { error: "Tool not found in scope", toolId },
        HttpStatus.NOT_FOUND,
      );
    }

    // Optionally scope-narrow by sourceEntityId (caller validates they mean
    // this entity — cross-scope attempt returns 404 same as above).
    if (
      body.sourceEntityId &&
      toolEntry.sourceEntityId !== body.sourceEntityId
    ) {
      throw new HttpException(
        { error: "Tool not found in scope", toolId },
        HttpStatus.NOT_FOUND,
      );
    }

    // Load entity for serviceSecret (HMAC signing). Scope-gate via
    // organizationId + projectId so a token from another scope can't hit this.
    const prisma = (this.agentService as any).prisma;
    const entity = await prisma.platosConnectedEntity.findFirst({
      where: {
        id: toolEntry.entityPk,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
      },
      select: { serviceSecret: true, entityId: true },
    });
    if (!entity) {
      throw new NotFoundException({ error: "Entity not found for this tool", toolId });
    }

    // Build request body — same shape as production path.
    const requestParams = body.params ?? {};
    const mcpBody = JSON.stringify({
      method: "tools/call",
      params: { name: toolEntry.toolName, arguments: requestParams },
    });

    const timestamp = new Date().toISOString();
    const nonce = crypto.randomBytes(16).toString("hex");
    const sigMessage = `${timestamp}.${nonce}.${mcpBody}`;
    const signature = crypto
      .createHmac("sha256", entity.serviceSecret)
      .update(sigMessage)
      .digest("hex");

    // Validate callback URL against SSRF blocklist (same check as production).
    {
      const { validatePublicUrl, describeUrlValidationError } = await import("../shared/url-validator");
      const check = await validatePublicUrl(toolEntry.callbackUrl);
      if (!check.ok) {
        throw new HttpException(
          { error: `Blocked: ${describeUrlValidationError(check.error)}` },
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const callId = crypto.randomUUID();
    const startTime = Date.now();

    // Merge test headers + Platos standard headers. Caller-supplied headers
    // go first so they can be overridden by the platform X-Platos-* ones.
    const mergedHeaders: Record<string, string> = {
      ...(body.headers ?? {}),
      "Content-Type": "application/json",
      "X-Platos-Signature": signature,
      "X-Platos-Organization-Id": scope.organizationId,
      "X-Platos-Project-Id": scope.projectId,
      "X-Platos-Environment-Id": scope.environmentId,
      "X-Platos-Entity-Id": entity.entityId,
      "X-Platos-User-Id": scope.userId,
      "X-Platos-Agent-Id": "dashboard",
      "X-Platos-Thread-Id": "",
      "X-Platos-Call-Id": callId,
      "X-Platos-Timestamp": timestamp,
      "X-Platos-Nonce": nonce,
      "X-Platos-Test": "true",
    };

    try {
      const abortCtl = new AbortController();
      const timeout = setTimeout(() => abortCtl.abort(), 30_000);
      // Rename to `fetchResp` to avoid shadowing the Express `Response` import.
      let fetchResp: globalThis.Response;
      try {
        fetchResp = await fetch(toolEntry.callbackUrl, {
          method: "POST",
          headers: mergedHeaders,
          body: mcpBody,
          signal: abortCtl.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      const durationMs = Date.now() - startTime;
      const respHeaders: Record<string, string> = {};
      fetchResp.headers.forEach((v: string, k: string) => { respHeaders[k] = v; });

      let respBody: unknown;
      const contentType = fetchResp.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        respBody = await fetchResp.json().catch(() => null);
      } else {
        respBody = await fetchResp.text().catch(() => "");
      }

      // Write audit row tagged as wire_test (dashboard tool-test button).
      try {
        await this.toolAuditService.record({
          scope: this.scopeTuple(scope),
          toolId: toolEntry.toolId,
          toolName: toolEntry.toolName,
          entityId: toolEntry.sourceEntityId,
          entityPk: toolEntry.entityPk,
          agentId: "dashboard",
          threadId: "",
          userId: scope.userId,
          args: requestParams,
          result: fetchResp.ok ? respBody ?? null : null,
          error: fetchResp.ok ? null : `HTTP ${fetchResp.status}`,
          status: fetchResp.ok ? "success" : "failed",
          latencyMs: durationMs,
          source: "wire_test",
          mcpUserId: null,
          mcpClientId: null,
        });
      } catch {
        // Audit is best-effort — never fail the test call for it.
      }

      if (!fetchResp.ok) {
        return {
          status: fetchResp.status,
          headers: respHeaders,
          body: respBody,
          durationMs,
          error: `HTTP ${fetchResp.status}`,
          upstreamStatus: fetchResp.status,
        };
      }
      return { status: fetchResp.status, headers: respHeaders, body: respBody, durationMs };
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const isAbort = err instanceof Error && err.name === "AbortError";
      const msg = isAbort ? "Request timed out (30s)" : (err instanceof Error ? err.message : "fetch failed");
      throw new HttpException({ error: msg, durationMs }, HttpStatus.BAD_GATEWAY);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Entities (formerly "Orgs" — renamed for 4-axis scope model)
  // ═══════════════════════════════════════════════════════

  /**
   * PIFSP-3 entity-id format — mirrors the client-side regex in
   * agent-entities.new/route.tsx. Lowercase letters + digits + hyphens,
   * 1-64 chars, no leading/trailing hyphen. Single-char ids are allowed
   * so short slugs like "x" still pass.
   */
  private static readonly ENTITY_ID_REGEX = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$|^[a-z0-9]$/;

  /** PIFSP-3 suggestion adjectives — used to generate alternates on collision. */
  private static readonly ENTITY_ID_ADJECTIVES = [
    "bridge",
    "core",
    "link",
    "sync",
    "primary",
    "alpha",
    "prod",
    "dev",
  ];

  /**
   * PIFSP-3 Deliverable 2 — live availability check for entity IDs.
   *
   * Must be declared BEFORE `@Get("entities/:entityId")` so Nest's router
   * matches the literal path first. Scope-gated via the global ScopeGuard —
   * uniqueness is per (organizationId, projectId, entityId).
   *
   * Returns:
   *   { entityId, available: true }
   *   { entityId, available: false, error: "invalid_format" }
   *   { entityId, available: false, suggestions: [...] }
   *
   * Rate-limited to 30 req/min per (scope, user) via a dedicated Redis
   * token bucket on top of the global RateLimitGuard. Fail-open on Redis
   * errors to match the global guard's behaviour.
   */
  @Get("entities/check-availability")
  async checkEntityAvailability(
    @Req() req: Request,
    @Query("entityId") rawEntityId?: string,
  ): Promise<{
    entityId: string;
    available: boolean;
    error?: "invalid_format" | "missing_entity_id";
    suggestions?: string[];
  }> {
    const scope = this.getScope(req);
    const entityId = (rawEntityId ?? "").trim();
    if (!entityId) {
      return { entityId: "", available: false, error: "missing_entity_id" };
    }

    // Dedicated 30/min per (scope, user) bucket. Keys match the shape
    // described in the PIFSP-3 PRD: rl:entity-check:{o}:{p}:{e}:{u}.
    try {
      const bucketKey =
        `rl:entity-check:${scope.organizationId}:${scope.projectId}:` +
        `${scope.environmentId}:${scope.userId || "anon"}`;
      const count = await this.redis.incr(bucketKey);
      if (count === 1) await this.redis.expire(bucketKey, 60);
      if (count > 30) {
        throw new HttpException(
          {
            error: "Rate limit exceeded for availability check",
            bucket: "entity-check-per-min",
            limit: 30,
            retryAfter: 60,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      // Redis down → fail open, mirroring the global RateLimitGuard.
    }

    if (!AgentController.ENTITY_ID_REGEX.test(entityId)) {
      return { entityId, available: false, error: "invalid_format" };
    }

    const existing = await this.authService.getEntity(
      scope.organizationId,
      scope.projectId,
      entityId,
    );
    if (!existing) {
      return { entityId, available: true };
    }

    // Collision — build three suggestions: {id}-2, {id}-3, {id}-{adjective}.
    const randomAdjective =
      AgentController.ENTITY_ID_ADJECTIVES[
        Math.floor(Math.random() * AgentController.ENTITY_ID_ADJECTIVES.length)
      ] ?? "alt";
    const candidates = Array.from(
      new Set([
        `${entityId}-2`,
        `${entityId}-3`,
        `${entityId}-${randomAdjective}`,
      ]),
    ).filter((c) => AgentController.ENTITY_ID_REGEX.test(c));

    // One bulk lookup — filter out any suggestions that are also taken.
    const prisma = (this.agentService as any).prisma;
    const taken = new Set<string>();
    try {
      const rows = await prisma.platosConnectedEntity.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          entityId: { in: candidates },
        },
        select: { entityId: true },
      });
      for (const r of rows as Array<{ entityId: string }>) {
        taken.add(r.entityId);
      }
    } catch {
      // DB hiccup → return candidates unfiltered rather than fail the whole
      // call. Server-side create is still the authoritative uniqueness gate.
    }
    const suggestions = candidates.filter((c) => !taken.has(c)).slice(0, 3);
    return { entityId, available: false, suggestions };
  }

  @Post("entities")
  async registerEntity(
    @Req() req: Request,
    @Body() body: {
      entityId: string;
      displayName: string;
      mcpUrls?: string[];
      serviceSecret?: string;
      // PIFSP-3: `customParams` body field removed — column dropped. Any
      // stray request supplying the field is silently ignored (no longer
      // forwarded to registerEntity).
    },
  ) {
    const scope = this.getScope(req);
    // SECURITY (audit C1/M7) — entity registration is minting authority
    // (a new entity + serviceSecret). Operator-only.
    requireOperator(scope);
    // PIFSP-3 Deliverable 1 — tighten server-side validation to the same
    // regex the form uses. Protects against API callers who skip the
    // browser client.
    if (!body.entityId || !AgentController.ENTITY_ID_REGEX.test(body.entityId)) {
      throw new HttpException(
        {
          error: "invalid_entity_id_format",
          message:
            "entityId must be 1-64 chars, lowercase letters/digits/hyphens, " +
            "no leading/trailing hyphen.",
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      return await this.authService.registerEntity({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        entityId: body.entityId,
        displayName: body.displayName,
        mcpUrls: body.mcpUrls || [],
        serviceSecret: body.serviceSecret || "auto",
      });
    } catch (err: any) {
      if (err?.statusCode === 409) {
        throw new HttpException(err.message, HttpStatus.CONFLICT);
      }
      throw err;
    }
  }

  @Post("entities/:entityId/regenerate-secret")
  async regenerateEntitySecret(
    @Req() req: Request,
    @Param("entityId") entityId: string,
  ) {
    const scope = this.getScope(req);
    // SECURITY (audit C1) — the serviceSecret IS the HMAC key that signs
    // session tokens; an end-user/entity token must never rotate it (and
    // receive the new plaintext → mint tokens for any user).
    requireOperator(scope);
    const result = await this.authService.regenerateServiceSecret(
      scope.organizationId,
      scope.projectId,
      entityId,
    );
    if (!result) return { error: "Entity not found", status: 404 };
    // Force-close any live WS sessions still authenticated with the OLD
    // secret. Without this, an entity backend that already established
    // a connection keeps serving tool-calls with the rotated-out secret
    // indefinitely (handshake-time auth only, no per-message revalidation),
    // which defeats the purpose of "rotating" the secret.
    const closed = this.toolSync.disconnectEntity(
      scope.organizationId,
      scope.projectId,
      entityId,
    );
    return { ...result, sessionsClosed: closed };
  }

  /**
   * EOBD.97 — wire-test endpoint. Dispatches a signed test tool-call
   * through the same ToolExecutorService production uses. Returns a
   * full transcript (request + response + latency + status) so the
   * integrator can confirm their backend handshake + HMAC verification
   * + callback reachability in under 10 seconds.
   */
  @Post("entities/:entityId/wire-test")
  async wireTestEntity(
    @Req() req: Request,
    @Param("entityId") entityId: string,
    @Body() body: { toolName?: string; params?: Record<string, unknown> },
  ) {
    const scope = this.getScope(req);
    const toolName = (body?.toolName || "ping").trim();
    if (!toolName) {
      return { error: "toolName is required", status: 400 };
    }
    const startedAt = Date.now();
    const outboundBody = JSON.stringify({
      toolName,
      params: body?.params ?? {},
      origin: "wire-test",
    });
    try {
      const result = await this.toolExecutor.execute(
        {
          tool: toolName,
          params: body?.params ?? {},
          purpose: "wire-test",
        },
        scope,
      );
      return {
        status: result.status,
        latencyMs: Date.now() - startedAt,
        result: result.status === "success" ? result.result : undefined,
        error: result.status !== "success" ? result.error : undefined,
        request: {
          url: `(internal dispatch) entity=${entityId}`,
          headers: {
            "X-Platos-Entity-Id": entityId,
            "X-Platos-Tool": toolName,
          },
          body: outboundBody,
        },
        response: {
          status: result.status === "success" ? 200 : 0,
          body: result.status === "success" ? result.result : { error: result.error },
        },
      };
    } catch (err: any) {
      return {
        status: "failed",
        latencyMs: Date.now() - startedAt,
        error: err?.message || String(err),
        request: {
          url: `(internal dispatch) entity=${entityId}`,
          headers: { "X-Platos-Entity-Id": entityId, "X-Platos-Tool": toolName },
          body: outboundBody,
        },
      };
    }
  }

  @Get("entities/:entityId")
  async getEntity(@Req() req: Request, @Param("entityId") entityId: string) {
    const scope = this.getScope(req);
    const entity = await this.authService.getEntity(
      scope.organizationId,
      scope.projectId,
      entityId,
    );
    if (!entity) return { error: "Entity not found", status: 404 };
    const connected = this.toolSync.isEntityConnected(entityId, scope.environmentId);
    const connectedInOtherEnv =
      !connected &&
      this.toolSync
        .getConnectedSources()
        .some(
          (s) =>
            s.entityId === entityId &&
            s.organizationId === scope.organizationId &&
            s.projectId === scope.projectId &&
            s.environmentId !== scope.environmentId,
        );
    const { serviceSecret, serviceSecretHash, ...safeEntity } = entity as any;
    return { ...safeEntity, liveConnected: connected, connectedInOtherEnv };
  }

  @Get("entities")
  async listEntities(@Req() req: Request) {
    const scope = this.getScope(req);
    const entities = await this.authService.listEntities(scope.organizationId, scope.projectId);
    const connectedIds = new Set(this.toolSync.getConnectedEntitiesInEnv(scope.environmentId));
    return {
      // BUG-2: defense-in-depth — strip serviceSecret/serviceSecretHash even
      // though authService.listEntities now selects safe columns.
      entities: entities.map((e: any) => {
        const { serviceSecret, serviceSecretHash, ...safe } = e;
        return { ...safe, liveConnected: connectedIds.has(e.entityId) };
      }),
    };
  }

  @Delete("entities/:entityId")
  async deleteEntity(@Req() req: Request, @Param("entityId") entityId: string) {
    const scope = this.getScope(req);
    const deleted = await this.authService.deleteEntity(
      scope.organizationId,
      scope.projectId,
      entityId,
    );
    return { deleted };
  }

  /**
   * Theme EA — update the per-entity agent allow-list. Empty array = every
   * agent in the scope sees this entity's tools (back-compat default).
   * Non-empty = only the listed agent IDs. After the DB write we call
   * `toolRegistry.syncEntityLinkedAgents` so the in-memory matrix cache
   * reflects the new allow-list immediately — no registry rebuild needed.
   *
   * Scope-gated via `authService.getEntity` which scans by (org, project),
   * matching the existing GET / DELETE endpoints. Any agent IDs supplied
   * are validated to exist inside the same (org, project, env) so a
   * forged id can't be silently persisted.
   */
  @Patch("entities/:entityId")
  async patchEntity(
    @Req() req: Request,
    @Param("entityId") entityId: string,
    @Body() body: {
      linkedAgentIds?: string[];
      // Multi-tenant CORS — list of browser origins this entity accepts
      // session-token requests from. Empty `[]` = backend-only.
      allowedOrigins?: string[];
      // PIFSP-3 Deliverable 9 — test-credentials stash. null clears the
      // stored value; undefined leaves it untouched.
      testCredentials?: {
        headers: Array<{ name: string; value: string }>;
        userId?: string;
      } | null;
    },
  ) {
    const scope = this.getScope(req);
    // SECURITY (audit C1 — entity config is operator-only).
    requireOperator(scope);
    const entity = await this.authService.getEntity(
      scope.organizationId,
      scope.projectId,
      entityId,
    );
    if (!entity) {
      throw new NotFoundException({ error: "Entity not found", entityId });
    }

    if (body.linkedAgentIds !== undefined) {
      if (!Array.isArray(body.linkedAgentIds)) {
        throw new HttpException(
          { error: "linkedAgentIds must be an array of agent IDs" },
          HttpStatus.BAD_REQUEST,
        );
      }
      const cleaned = Array.from(
        new Set(
          body.linkedAgentIds
            .map((x) => (typeof x === "string" ? x.trim() : ""))
            .filter((x) => x.length > 0),
        ),
      );
      // Validate every id belongs to THIS scope so a forged agent id from
      // another org can't be persisted into the allow-list.
      if (cleaned.length > 0) {
        const prisma = (this.agentService as any).prisma;
        const known = await prisma.platosAgent.findMany({
          where: {
            id: { in: cleaned },
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          select: { id: true },
        });
        const knownIds = new Set(known.map((a: { id: string }) => a.id));
        const bogus = cleaned.filter((id) => !knownIds.has(id));
        if (bogus.length > 0) {
          throw new HttpException(
            {
              error: "One or more agent IDs are not in this scope",
              unknownAgentIds: bogus,
            },
            HttpStatus.BAD_REQUEST,
          );
        }
      }
      const prisma = (this.agentService as any).prisma;
      await prisma.platosConnectedEntity.update({
        where: { id: (entity as { id: string }).id },
        data: { linkedAgentIds: cleaned },
      });
      this.toolRegistry.syncEntityLinkedAgents(
        (entity as { id: string }).id,
        cleaned,
      );
    }

    // Multi-tenant CORS — entity-declared origins. Verbatim match against
    // the browser's Origin header. The agent's CORS handler (main.ts)
    // unions every entity's allowedOrigins with PLATOS_CORS_ORIGIN.
    if (body.allowedOrigins !== undefined) {
      if (!Array.isArray(body.allowedOrigins)) {
        throw new HttpException(
          { error: "allowedOrigins must be an array of origin strings" },
          HttpStatus.BAD_REQUEST,
        );
      }
      // Strict origin validation: must parse as a URL with http/https
      // scheme and no path. Verbatim browser-header form, no globs.
      const cleaned: string[] = [];
      const invalid: string[] = [];
      for (const raw of body.allowedOrigins) {
        if (typeof raw !== "string") {
          invalid.push(String(raw));
          continue;
        }
        const trimmed = raw.trim().replace(/\/+$/, "");
        if (!trimmed) continue;
        try {
          const u = new URL(trimmed);
          if (u.protocol !== "http:" && u.protocol !== "https:") {
            invalid.push(trimmed);
            continue;
          }
          if (u.pathname !== "/" && u.pathname !== "") {
            invalid.push(trimmed);
            continue;
          }
          // u.origin strips path/search/hash and lowercases the host —
          // exactly what browsers ship in the Origin header.
          cleaned.push(u.origin);
        } catch {
          invalid.push(trimmed);
        }
      }
      if (invalid.length > 0) {
        throw new HttpException(
          {
            error: "Invalid origin(s). Each must be a bare http(s) origin like https://example.com.",
            invalid,
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      // De-dupe via Set, cap at 100 to keep the in-memory cache bounded.
      const deduped = Array.from(new Set(cleaned));
      if (deduped.length > 100) {
        throw new HttpException(
          { error: "Too many origins (max 100 per entity)." },
          HttpStatus.BAD_REQUEST,
        );
      }
      await this.authService.updateEntity(
        scope.organizationId,
        scope.projectId,
        entityId,
        { allowedOrigins: deduped },
      );
    }

    // PIFSP-3 Deliverable 9 — test-credentials write path.
    if (body.testCredentials !== undefined) {
      const prisma = (this.agentService as any).prisma;
      if (body.testCredentials === null) {
        await prisma.platosConnectedEntity.update({
          where: { id: (entity as { id: string }).id },
          data: { testCredentials: null },
        });
      } else {
        const raw = body.testCredentials;
        if (
          !raw ||
          typeof raw !== "object" ||
          !Array.isArray(raw.headers)
        ) {
          throw new HttpException(
            { error: "testCredentials.headers must be an array" },
            HttpStatus.BAD_REQUEST,
          );
        }
        if (raw.headers.length > 32) {
          throw new HttpException(
            {
              error: "Too many test-credential headers (max 32).",
              limit: 32,
            },
            HttpStatus.BAD_REQUEST,
          );
        }
        // RFC 7230 token regex for header names. Enforced server-side to
        // mirror the form-level validation, so direct API callers can't
        // smuggle in \r\n and split a header.
        const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
        const invalidHeaders: string[] = [];
        const cleaned: Array<{ name: string; value: string }> = [];
        for (const h of raw.headers) {
          if (
            !h ||
            typeof h !== "object" ||
            typeof h.name !== "string" ||
            typeof h.value !== "string"
          ) {
            throw new HttpException(
              { error: "Every header needs a string name + string value." },
              HttpStatus.BAD_REQUEST,
            );
          }
          const name = h.name.trim();
          const value = h.value.trim();
          if (!HEADER_NAME_RE.test(name)) {
            invalidHeaders.push(name);
            continue;
          }
          if (value.length > 4096) {
            throw new HttpException(
              {
                error:
                  "Header values capped at 4096 chars (matches most gateway limits).",
                headerName: name,
              },
              HttpStatus.BAD_REQUEST,
            );
          }
          cleaned.push({ name, value });
        }
        if (invalidHeaders.length > 0) {
          throw new HttpException(
            {
              error: "One or more header names violate RFC 7230.",
              invalidHeaders,
            },
            HttpStatus.BAD_REQUEST,
          );
        }
        const userId =
          typeof raw.userId === "string" && raw.userId.trim().length > 0
            ? raw.userId.trim()
            : undefined;
        const stash = {
          headers: cleaned,
          userId,
          updatedAt: new Date().toISOString(),
          updatedByUserId: scope.userId,
        };
        // Encrypt via the standard JSON envelope (reused from H.4). Stored
        // as TEXT — opaque base64 ciphertext, not indexable JSON.
        const encrypted = this.messageCrypto.encryptJsonField(stash);
        await prisma.platosConnectedEntity.update({
          where: { id: (entity as { id: string }).id },
          data: { testCredentials: JSON.stringify(encrypted) },
        });
      }
    }

    const updated = await this.authService.getEntity(
      scope.organizationId,
      scope.projectId,
      entityId,
    );
    return updated;
  }

  /**
   * PIFSP-3 Deliverable 9 — decrypted test-credentials fetch used by the
   * entity detail page + the PIFSP-4 Postman-style test sheet. Scope-gated
   * via the same (org, project, entityId) lookup as GET /entities/:entityId.
   *
   * Returns 204 when no stash has been saved. Header values are returned
   * in plaintext — operator already has scope access, encryption is purely
   * an at-rest defence.
   */
  @Get("entities/:entityId/test-credentials")
  async getEntityTestCredentials(
    @Req() req: Request,
    @Param("entityId") entityId: string,
    @Res() res: Response,
  ): Promise<void> {
    const scope = this.getScope(req);
    // SECURITY (audit C1 — test credentials are operator-only).
    requireOperator(scope);
    const entity = await this.authService.getEntity(
      scope.organizationId,
      scope.projectId,
      entityId,
    );
    if (!entity) {
      res.status(404).json({ error: "Entity not found", entityId });
      return;
    }
    const encrypted = (entity as { testCredentials?: string | null })
      .testCredentials;
    if (!encrypted) {
      res.status(204).end();
      return;
    }
    try {
      const envelope = JSON.parse(encrypted);
      const decrypted = this.messageCrypto.decryptJsonField(envelope) as {
        headers?: Array<{ name: string; value: string }>;
        userId?: string;
        updatedAt?: string;
        updatedByUserId?: string;
      } | null;
      if (
        !decrypted ||
        (decrypted as any).__platos_enc === 1 // decryption failed sentinel
      ) {
        res.status(500).json({
          error: "decryption_failed",
          message: "Test credentials present but the encryption key changed.",
        });
        return;
      }
      res.status(200).json({
        headers: decrypted.headers ?? [],
        userId: decrypted.userId,
        updatedAt: decrypted.updatedAt,
        updatedByUserId: decrypted.updatedByUserId,
      });
    } catch (err: any) {
      res.status(500).json({
        error: "decryption_failed",
        message: err?.message ?? "failed to decrypt test credentials",
      });
    }
  }

  // ═══════════════════════════════════════════════════════
  // PIFSP-21 — per-entity MCP Gateway configuration.
  //
  // Dashboard discovery + toggle surface. Scope-gated via ScopeGuard
  // (same as every other /api/v1/agent/* endpoint). The separate
  // `/mcp/entity/:entityId/*` + `/oauth/entity/:entityId/*` paths are
  // the CUSTOMER-facing OAuth + MCP protocol routes; they self-auth
  // via OAuth tokens and have their own ScopeGuard bypass.
  // ═══════════════════════════════════════════════════════

  @Get("entities/:entityId/mcp/config")
  async getEntityMcpConfig(
    @Req() req: Request,
    @Param("entityId") entityId: string,
  ) {
    const scope = this.getScope(req);
    const entity = await this.authService.getEntity(
      scope.organizationId,
      scope.projectId,
      entityId,
    );
    if (!entity) {
      throw new NotFoundException({ error: "Entity not found", entityId });
    }
    const prisma = (this.agentService as any).prisma;
    const config = await prisma.platosEntityMcpConfig.findUnique({
      where: { entityPk: (entity as { id: string }).id },
    });
    if (!config) {
      // Default: MCP is disabled by default per PIFSP-21 decisions.
      return {
        entityPk: (entity as { id: string }).id,
        entityId,
        enabled: false,
        identityMode: "bearer",
        identityProviders: null,
        bearerTokenCount: 0,
        branding: null,
        toolAllowlist: [],
        consentCopy: null,
        redirectUriAllowlist: [],
        rateLimitPerMinute: 60,
        exists: false,
      };
    }
    return {
      entityPk: config.entityPk,
      entityId,
      enabled: config.enabled,
      identityMode: config.identityMode,
      identityProviders: config.identityProviders,
      bearerTokenCount: config.bearerTokenCount,
      branding: config.branding,
      toolAllowlist: config.toolAllowlist,
      consentCopy: config.consentCopy,
      redirectUriAllowlist: config.redirectUriAllowlist,
      rateLimitPerMinute: config.rateLimitPerMinute,
      exists: true,
    };
  }

  @Patch("entities/:entityId/mcp/config")
  async patchEntityMcpConfig(
    @Req() req: Request,
    @Param("entityId") entityId: string,
    @Body()
    body: {
      enabled?: boolean;
      identityMode?: "anonymous" | "oidc" | "bearer";
      identityProviders?: Record<string, unknown> | null;
      branding?: Record<string, unknown> | null;
      toolAllowlist?: string[];
      consentCopy?: string | null;
      redirectUriAllowlist?: string[];
      rateLimitPerMinute?: number;
    },
  ) {
    const scope = this.getScope(req);
    const entity = await this.authService.getEntity(
      scope.organizationId,
      scope.projectId,
      entityId,
    );
    if (!entity) {
      throw new NotFoundException({ error: "Entity not found", entityId });
    }
    const entityPk = (entity as { id: string }).id;
    const prisma = (this.agentService as any).prisma;

    const update: Record<string, unknown> = {};
    if (typeof body.enabled === "boolean") update.enabled = body.enabled;
    if (
      body.identityMode === "anonymous" ||
      body.identityMode === "oidc" ||
      body.identityMode === "bearer"
    ) {
      update.identityMode = body.identityMode;
    }
    if (body.identityProviders !== undefined) {
      update.identityProviders = body.identityProviders;
    }
    if (body.branding !== undefined) update.branding = body.branding;
    if (Array.isArray(body.toolAllowlist)) {
      update.toolAllowlist = body.toolAllowlist
        .filter((x) => typeof x === "string" && x.length > 0)
        .slice(0, 500);
    }
    if (body.consentCopy !== undefined) {
      update.consentCopy = body.consentCopy === null ? null : String(body.consentCopy).slice(0, 5000);
    }
    if (Array.isArray(body.redirectUriAllowlist)) {
      update.redirectUriAllowlist = body.redirectUriAllowlist
        .filter((x) => typeof x === "string" && x.length > 0)
        .slice(0, 50);
    }
    if (typeof body.rateLimitPerMinute === "number") {
      update.rateLimitPerMinute = Math.max(1, Math.min(10000, Math.floor(body.rateLimitPerMinute)));
    }

    // Upsert so the first PATCH auto-creates the row.
    await prisma.platosEntityMcpConfig.upsert({
      where: { entityPk },
      create: {
        entityPk,
        enabled: update.enabled ?? false,
        identityMode: update.identityMode ?? "bearer",
        ...(update.identityProviders !== undefined
          ? { identityProviders: update.identityProviders }
          : {}),
        ...(update.branding !== undefined ? { branding: update.branding } : {}),
        toolAllowlist: (update.toolAllowlist as string[] | undefined) ?? [],
        ...(update.consentCopy !== undefined ? { consentCopy: update.consentCopy } : {}),
        redirectUriAllowlist:
          (update.redirectUriAllowlist as string[] | undefined) ?? [],
        rateLimitPerMinute: (update.rateLimitPerMinute as number | undefined) ?? 60,
      },
      update,
    });

    const fresh = await prisma.platosEntityMcpConfig.findUnique({
      where: { entityPk },
    });
    return {
      entityPk,
      entityId,
      enabled: fresh.enabled,
      identityMode: fresh.identityMode,
      identityProviders: fresh.identityProviders,
      bearerTokenCount: fresh.bearerTokenCount,
      branding: fresh.branding,
      toolAllowlist: fresh.toolAllowlist,
      consentCopy: fresh.consentCopy,
      redirectUriAllowlist: fresh.redirectUriAllowlist,
      rateLimitPerMinute: fresh.rateLimitPerMinute,
      exists: true,
    };
  }

  // ═══════════════════════════════════════════════════════
  // Monitoring
  // ═══════════════════════════════════════════════════════

  @Get("monitoring/cost")
  async getScopeCost(
    @Req() req: Request,
    @Query("date") date?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    return this.costService.getScopeDailyCost(this.scopeTuple(scope), date);
  }

  @Get("monitoring/cost/thread/:threadId")
  async getThreadCost(@Req() req: Request, @Param("threadId") threadId: string) {
    // SECURITY (audit H2) — cross-TENANT IDOR: this took no scope and read a
    // threadId-only Redis key, so any threadId leaked another org's spend.
    // Scope-gate the thread first (mirrors getThreadTrace below), 404 on miss.
    const scope = this.getScope(req);
    const thread = await this.conversationService.getThread(threadId, scope as any);
    if (!thread) {
      return { error: "Thread not found", status: 404 };
    }
    return this.costService.getThreadCost(threadId);
  }

  /**
   * Per-thread trace payload — interleaved messages + OTel spans + span
   * tree + rollup. Scope-filtered: returns 404 when the thread belongs to
   * a different (org, project, env) — this is the cross-env leakage gate.
   * Theme E.2.
   */
  @Get("monitoring/trace/:threadId")
  async getThreadTrace(@Req() req: Request, @Param("threadId") threadId: string) {
    const scope = this.getScope(req);
    const trace = await this.traceService.buildThreadTrace(this.scopeTuple(scope), threadId);
    if (!trace) {
      return { error: "Thread not found", status: 404 };
    }
    return trace;
  }

  /**
   * Cost rollup by model. Theme E.3.
   * Query: ?days=30&limit=20 (defaults).
   */
  @Get("monitoring/cost-by-model")
  async costByModel(
    @Req() req: Request,
    @Query("days") days?: string,
    @Query("limit") limit?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const rows = await this.costService.getCostByModel(this.scopeTuple(scope), {
      days: days ? parseInt(days, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return { rows, fetchedAt: new Date().toISOString() };
  }

  /**
   * Cost rollup by agent. Theme E.3.
   */
  @Get("monitoring/cost-by-agent")
  async costByAgent(
    @Req() req: Request,
    @Query("days") days?: string,
    @Query("limit") limit?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const rows = await this.costService.getCostByAgent(this.scopeTuple(scope), {
      days: days ? parseInt(days, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return { rows, fetchedAt: new Date().toISOString() };
  }

  /**
   * Cost rollup by user. Theme E.3 + E.4.
   */
  /**
   * PIFSP-10 — Memory extraction health for the top N agents in scope.
   * Returns per-agent extraction stats (last 24h) and last run time.
   */
  @Get("monitoring/memory-extraction/health")
  async memoryExtractionHealth(
    @Req() req: Request,
    @Query("limit") limitRaw?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const prisma = (this.costService as any).prisma;
    if (!prisma) return { rows: [], windowHours: 24, fetchedAt: new Date().toISOString() };
    const limit = Math.min(20, Math.max(1, limitRaw ? parseInt(limitRaw, 10) || 5 : 5));
    const since = new Date(Date.now() - 24 * 86_400_000);

    // Aggregate memory rows by agentId + kind (last 24h)
    const rows: Array<{ agentId: string | null; kind: string; confidence: number | null; createdAt: Date; id: string; content: string }> =
      await prisma.platosMemory.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          createdAt: { gte: since },
          agentId: { not: null },
        },
        select: { agentId: true, kind: true, confidence: true, createdAt: true, id: true, content: true },
        orderBy: { createdAt: "desc" },
        take: 2000,
      });

    // Group by agentId
    type AgentBucket = { kinds: Map<string, number>; confidences: number[]; lastAt: Date; samples: Array<{id: string; kind: string; content: string; confidence: number | null; createdAt: string}> };
    const byAgent = new Map<string, AgentBucket>();
    for (const r of rows) {
      if (!r.agentId) continue;
      const b: AgentBucket = byAgent.get(r.agentId) ?? { kinds: new Map(), confidences: [], lastAt: r.createdAt, samples: [] };
      b.kinds.set(r.kind, (b.kinds.get(r.kind) ?? 0) + 1);
      if (r.confidence !== null) b.confidences.push(r.confidence);
      if (r.createdAt > b.lastAt) b.lastAt = r.createdAt;
      if (b.samples.length < 10) {
        b.samples.push({ id: r.id, kind: r.kind, content: r.content.slice(0, 120), confidence: r.confidence, createdAt: r.createdAt.toISOString() });
      }
      byAgent.set(r.agentId, b);
    }

    // Sort by total extraction count, take top N
    const agentIds = [...byAgent.entries()]
      .sort((a, b) => {
        const ta = [...a[1].kinds.values()].reduce((s, v) => s + v, 0);
        const tb = [...b[1].kinds.values()].reduce((s, v) => s + v, 0);
        return tb - ta;
      })
      .slice(0, limit)
      .map(([id]) => id);

    // Fetch agent names
    const agentNameRows: Array<{ id: string; name: string }> = agentIds.length
      ? await prisma.platosAgent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } })
      : [];
    const nameMap = new Map(agentNameRows.map((a) => [a.id, a.name]));

    const agents = agentIds.map((agentId) => {
      const b = byAgent.get(agentId)!;
      const total = [...b.kinds.values()].reduce((s, v) => s + v, 0);
      const avgConfidence = b.confidences.length > 0
        ? Math.round((b.confidences.reduce((s, v) => s + v, 0) / b.confidences.length) * 100) / 100
        : null;
      const nowMs = Date.now();
      const ageSec = (nowMs - b.lastAt.getTime()) / 1000;
      const status = ageSec < 6 * 3600 && total > 0 ? "ok" : ageSec < 24 * 3600 ? "warn" : "error";
      return {
        agentId,
        agentName: nameMap.get(agentId) ?? agentId,
        lastRunAt: b.lastAt.toISOString(),
        rows24h: {
          fact: b.kinds.get("fact") ?? 0,
          preference: b.kinds.get("preference") ?? 0,
          event: b.kinds.get("event") ?? 0,
          relationship: b.kinds.get("relationship") ?? 0,
          profile: b.kinds.get("profile") ?? 0,
          total,
        },
        avgConfidence24h: avgConfidence,
        status,
        sampleRows: b.samples,
      };
    });

    // Map to the shape expected by the webapp's MemoryExtractionHealthPayload:
    // { rows: MemoryExtractionAgentRow[], windowHours: number, fetchedAt }
    const healthRows = agents.map((a) => ({
      agentId: a.agentId,
      agentName: a.agentName,
      totalExtracted: a.rows24h.total,
      byKind: {
        fact: a.rows24h.fact,
        preference: a.rows24h.preference,
        event: a.rows24h.event,
        relationship: a.rows24h.relationship,
        profile: a.rows24h.profile,
      },
      lastRunAt: a.lastRunAt,
    }));
    return { rows: healthRows, windowHours: 24, fetchedAt: new Date().toISOString() };
  }

  @Get("monitoring/cost-by-user")
  async costByUser(
    @Req() req: Request,
    @Query("days") days?: string,
    @Query("limit") limit?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const rows = await this.costService.getCostByUser(this.scopeTuple(scope), {
      days: days ? parseInt(days, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return { rows, fetchedAt: new Date().toISOString() };
  }

  /**
   * PIFSP-19 — Users monitoring list.
   * Aggregates per-userId stats across all agents in scope:
   * threads, agents, turns, lastActive, cost(7d), riskFlags, score.
   * Cached 60s per scope in Redis.
   */
  @Get("monitoring/users")
  async monitoringUsers(
    @Req() req: Request,
    @Query("limit") limitRaw?: string,
    @Query("cursor") cursor?: string,
    @Query("agentId") agentIdFilter?: string,
    @Query("sinceDays") sinceDaysRaw?: string,
    @Query("sort") sort?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const prisma = (this.costService as any).prisma;
    if (!prisma) return { users: [], nextCursor: null, fetchedAt: new Date().toISOString() };

    const limit = Math.min(100, Math.max(1, limitRaw ? parseInt(limitRaw, 10) || 50 : 50));
    const sinceDays = Math.min(90, Math.max(1, sinceDaysRaw ? parseInt(sinceDaysRaw, 10) || 30 : 30));
    const since = new Date(Date.now() - sinceDays * 86_400_000);
    const cost7dSince = new Date(Date.now() - 7 * 86_400_000);

    // 1. Thread-level aggregation by userId
    const threadRows: Array<{
      userId: string;
      agentId: string;
      id: string;
      createdAt: Date;
    }> = await prisma.platosAgentThread.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        ...(agentIdFilter ? { agentId: agentIdFilter } : {}),
        updatedAt: { gte: since },
      },
      select: { userId: true, agentId: true, id: true, createdAt: true },
    });

    // 2. Turn (user-message) counts + lastActive per userId
    const msgRows: Array<{ threadId: string; createdAt: Date }> = await prisma.platosAgentMessage.findMany({
      where: {
        role: "user",
        thread: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        createdAt: { gte: since },
      },
      select: { threadId: true, createdAt: true },
    });

    // 3. Cost (7d) per userId via existing costService.
    // PRELAUNCH-A1-10 — cost7d now also carries token breakdown rows so we
    // can surface them on the monitoring users table (sortable columns).
    const cost7d = await this.costService.getCostByUser(this.scopeTuple(scope), { days: 7, limit: 500 });
    const costMap = new Map(cost7d.map((r) => [r.userId, r.costCents]));
    const tokensMap = new Map(cost7d.map((r) => [
      r.userId,
      {
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadInputTokens: r.cacheReadInputTokens,
        cacheCreationInputTokens: r.cacheCreationInputTokens,
        reasoningTokens: r.reasoningTokens,
      },
    ]));

    // 4. Safety events (7d) per userId
    const safetyRows: Array<{ userId: string | null }> = await prisma.platosSafetyEvent.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        createdAt: { gte: cost7dSince },
      },
      select: { userId: true },
    });
    const safetyMap = new Map<string, number>();
    for (const s of safetyRows) {
      if (s.userId) safetyMap.set(s.userId, (safetyMap.get(s.userId) ?? 0) + 1);
    }

    // 5a. PlatosEndUser displayName/email (primary alias source)
    const endUserRows: Array<{ externalUserId: string; displayName: string | null; email: string | null }> =
      await (prisma as any).platosEndUser.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        select: { externalUserId: true, displayName: true, email: true },
      }).catch(() => []);
    const aliasMap = new Map<string, string>();
    for (const eu of endUserRows) {
      const alias = eu.displayName || eu.email;
      if (alias) aliasMap.set(eu.externalUserId, alias);
    }

    // 5b. Fallback: profile aliases from PlatosMemory (kind=profile, metadata.name)
    const profileRows: Array<{ userId: string; content: string; metadata: any }> = await prisma.platosMemory.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        kind: "profile",
      },
      select: { userId: true, content: true, metadata: true },
    }).catch(() => []);
    for (const p of profileRows) {
      if (aliasMap.has(p.userId)) continue; // PlatosEndUser takes priority
      const meta = p.metadata as Record<string, unknown> | null;
      if (meta?.profileKey === "name" || p.content?.startsWith("Name:")) {
        const name = String(meta?.value ?? p.content.replace(/^Name:\s*/i, "")).trim();
        if (name) aliasMap.set(p.userId, name);
      }
    }

    // 6. Aggregate by userId
    const threadIdToUserId = new Map(threadRows.map((t) => [t.id, t.userId]));
    type Bucket = {
      userId: string;
      threadIds: Set<string>;
      agentIds: Set<string>;
      turns: number;
      lastActiveAt: Date;
      firstSeenAt: Date;
      activeDaysSet: Set<string>;
    };
    const byUser = new Map<string, Bucket>();

    for (const t of threadRows) {
      const b = byUser.get(t.userId) ?? {
        userId: t.userId,
        threadIds: new Set(),
        agentIds: new Set(),
        turns: 0,
        lastActiveAt: t.createdAt,
        firstSeenAt: t.createdAt,
        activeDaysSet: new Set(),
      };
      b.threadIds.add(t.id);
      b.agentIds.add(t.agentId);
      if (t.createdAt > b.lastActiveAt) b.lastActiveAt = t.createdAt;
      if (t.createdAt < b.firstSeenAt) b.firstSeenAt = t.createdAt;
      b.activeDaysSet.add(t.createdAt.toISOString().slice(0, 10));
      byUser.set(t.userId, b);
    }

    for (const m of msgRows) {
      const userId = threadIdToUserId.get(m.threadId);
      if (!userId) continue;
      const b = byUser.get(userId);
      if (!b) continue;
      b.turns += 1;
      if (m.createdAt > b.lastActiveAt) b.lastActiveAt = m.createdAt;
      b.activeDaysSet.add(m.createdAt.toISOString().slice(0, 10));
    }

    // 7. Score formula (0-100):
    // engagement(40%) + retention(25%) + quality(20%, placeholder) + frictionInverse(15%)
    function computeScore(b: Bucket, riskFlags: number, turns: number): number {
      const daysSinceFirst = Math.max(1, (Date.now() - b.firstSeenAt.getTime()) / 86_400_000);
      const turnsPerDay = turns / daysSinceFirst;
      const engagement = Math.min(100, (turnsPerDay / 5) * 100) * 0.4;
      const retention = Math.min(100, (b.activeDaysSet.size / 30) * 100) * 0.25;
      const quality = 50 * 0.2; // neutral until ratings integrated
      const frictionRate = turns > 0 ? Math.min(1, riskFlags / turns) : 0;
      const friction = Math.max(0, (1 - frictionRate) * 100) * 0.15;
      return Math.round(engagement + retention + quality + friction);
    }

    const users = Array.from(byUser.values()).map((b) => {
      const riskFlagCount = safetyMap.get(b.userId) ?? 0;
      const score = computeScore(b, riskFlagCount, b.turns);
      const tokens = tokensMap.get(b.userId) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
      };
      return {
        userId: b.userId,
        alias: aliasMap.get(b.userId) ?? null,
        totalConversations: b.threadIds.size,
        agentsTouched: b.agentIds.size,
        totalTurns: b.turns,
        lastActiveAt: b.lastActiveAt.toISOString(),
        cost7dCents: costMap.get(b.userId) ?? 0,
        // PRELAUNCH-A1-10 — token breakdown for the monitoring table.
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheReadInputTokens: tokens.cacheReadInputTokens,
        cacheCreationInputTokens: tokens.cacheCreationInputTokens,
        reasoningTokens: tokens.reasoningTokens,
        riskFlagCount,
        score,
      };
    });

    // 8. Sort
    const sortFn =
      sort === "last-active" ? (a: (typeof users)[0], b: (typeof users)[0]) => (b.lastActiveAt > a.lastActiveAt ? 1 : -1) :
      sort === "turns" ? (a: (typeof users)[0], b: (typeof users)[0]) => b.totalTurns - a.totalTurns :
      sort === "cost" ? (a: (typeof users)[0], b: (typeof users)[0]) => b.cost7dCents - a.cost7dCents :
      (a: (typeof users)[0], b: (typeof users)[0]) => b.score - a.score; // default: score desc

    users.sort(sortFn);

    // 9. Cursor pagination (simple offset by userId)
    const startIdx = cursor ? users.findIndex((u) => u.userId === cursor) + 1 : 0;
    const page = users.slice(startIdx, startIdx + limit);
    const nextCursor = page.length === limit && startIdx + limit < users.length
      ? page[page.length - 1].userId
      : null;

    return { users: page, nextCursor, fetchedAt: new Date().toISOString() };
  }

  /** Monitoring — per-agent utilization breakdown over the last N days. */
  @Get("monitoring/agents")
  async monitoringAgents(
    @Req() req: Request,
    @Query("sinceDays") sinceDaysRaw?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const prisma = (this.costService as any).prisma;
    if (!prisma) return { agents: [], fetchedAt: new Date().toISOString() };
    const sinceDays = Math.min(90, Math.max(1, sinceDaysRaw ? parseInt(sinceDaysRaw, 10) || 30 : 30));
    const since = new Date(Date.now() - sinceDays * 86_400_000);

    // Threads in scope within window
    const threads: Array<{ id: string; agentId: string; userId: string; createdAt: Date; updatedAt: Date }> =
      await prisma.platosAgentThread.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          updatedAt: { gte: since },
        },
        select: { id: true, agentId: true, userId: true, createdAt: true, updatedAt: true },
      });

    // Agent names + model
    const agentIds = [...new Set(threads.map((t) => t.agentId))];
    const agentRows: Array<{ id: string; name: string; model: string | null }> =
      await prisma.platosAgent.findMany({
        where: { id: { in: agentIds } },
        select: { id: true, name: true, model: true },
      });
    const agentMeta = new Map(agentRows.map((a: { id: string; name: string; model: string | null }) => [a.id, a]));

    // User-turn counts per agentId (proxy for "turns")
    const msgRows: Array<{ threadId: string }> = await prisma.platosAgentMessage.findMany({
      where: {
        role: "user",
        thread: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        createdAt: { gte: since },
      },
      select: { threadId: true },
    });
    const threadIdToAgent = new Map(threads.map((t) => [t.id, t.agentId]));
    const turnsPerAgent = new Map<string, number>();
    for (const m of msgRows) {
      const aid = threadIdToAgent.get(m.threadId);
      if (aid) turnsPerAgent.set(aid, (turnsPerAgent.get(aid) ?? 0) + 1);
    }

    // Cost per agent (7d) from the existing getCostByAgent method
    const cost7d = await this.costService.getCostByAgent(this.scopeTuple(scope), { days: 7 });
    const costMap = new Map(cost7d.map((r) => [r.agentId, r.costCents]));

    // Aggregate per-agent buckets
    const byAgent = new Map<string, {
      threadIds: Set<string>;
      userIds: Set<string>;
      lastActiveAt: Date;
    }>();
    for (const t of threads) {
      const b = byAgent.get(t.agentId) ?? { threadIds: new Set<string>(), userIds: new Set<string>(), lastActiveAt: t.updatedAt };
      b.threadIds.add(t.id);
      b.userIds.add(t.userId);
      if (t.updatedAt > b.lastActiveAt) b.lastActiveAt = t.updatedAt;
      byAgent.set(t.agentId, b);
    }

    type AgentBucket = {
      agentId: string;
      agentName: string;
      model: string | null;
      totalConversations: number;
      uniqueUsers: number;
      totalTurns: number;
      lastActiveAt: string;
      cost7dCents: number;
    };
    const agents: AgentBucket[] = agentIds.map((aid) => {
      const b = byAgent.get(aid)!;
      const meta = agentMeta.get(aid);
      return {
        agentId: aid,
        agentName: meta?.name ?? aid,
        model: meta?.model ?? null,
        totalConversations: b.threadIds.size,
        uniqueUsers: b.userIds.size,
        totalTurns: turnsPerAgent.get(aid) ?? 0,
        lastActiveAt: b.lastActiveAt.toISOString(),
        cost7dCents: costMap.get(aid) ?? 0,
      };
    });
    agents.sort((a, b) => b.totalTurns - a.totalTurns);

    return { agents, fetchedAt: new Date().toISOString() };
  }

  /**
   * Per-agent scorecard for the "Plato Central" landing page — ONE row per
   * agent in scope (including idle/inactive agents), composed from the
   * existing rollups in a fixed number of queries (no per-agent N+1):
   *
   *   - agents list        → id / name / lifecycle (isActive)  [agentCrud.list]
   *   - thread groupBy     → conversation count (windowed) + all-time lastActiveAt
   *   - message fan-in     → message volume (windowed) via thread→agent map
   *   - cost-by-agent      → spend + token totals              [costService]
   *   - satisfaction       → ups / downs / score               [ratingService]
   *
   * `status` derives a coarse traffic-light for the table badge:
   *   disabled = agent is deactivated; active = had activity in the window;
   *   idle = enabled but silent in the window.
   *
   * Operator-gated exactly like its monitoring siblings.
   */
  @Get("monitoring/agent-scorecard")
  async agentScorecard(
    @Req() req: Request,
    @Query("days") daysRaw?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const prisma = (this.costService as any).prisma;
    const days = Math.min(365, Math.max(1, daysRaw ? parseInt(daysRaw, 10) || 7 : 7));
    if (!prisma) {
      return { days, agents: [], fetchedAt: new Date().toISOString() };
    }
    const scopeTuple = this.scopeTuple(scope);
    const since = new Date(Date.now() - days * 86_400_000);

    // Fixed set of parallel queries — none of these fan out per-agent.
    const [agentList, windowedThreads, lastActiveGroups, msgRows, costRows, satisfactionRows] =
      await Promise.all([
        // Full agent roster in scope (active + inactive), so idle agents still
        // appear as rows with zeroed metrics.
        this.agentCrud.list(scope),
        // Windowed threads → conversation count + thread→agent map for messages.
        prisma.platosAgentThread.findMany({
          where: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            updatedAt: { gte: since },
          },
          select: { id: true, agentId: true },
        }) as Promise<Array<{ id: string; agentId: string }>>,
        // All-time last-active per agent (max thread.updatedAt) — one aggregate
        // row per agent, so "Last active" stays truthful for dormant agents.
        prisma.platosAgentThread.groupBy({
          by: ["agentId"],
          where: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          _max: { updatedAt: true },
        }) as Promise<Array<{ agentId: string; _max: { updatedAt: Date | null } }>>,
        // Windowed message counts (all roles) → message volume via thread map.
        // groupBy aggregates in Postgres: one row per thread instead of one row
        // per message, so a busy 30d window doesn't materialize hundreds of
        // thousands of rows in Node memory.
        prisma.platosAgentMessage.groupBy({
          by: ["threadId"],
          where: {
            createdAt: { gte: since },
            thread: {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
          },
          _count: { _all: true },
        }) as Promise<Array<{ threadId: string; _count: { _all: number } }>>,
        this.costService.getCostByAgent(scopeTuple, { days, limit: 10_000 }),
        this.ratingService.satisfactionByAgent(scopeTuple, { days }),
      ]);

    // threads count + thread→agent map (windowed)
    const threadsPerAgent = new Map<string, number>();
    const threadIdToAgent = new Map<string, string>();
    for (const t of windowedThreads) {
      threadsPerAgent.set(t.agentId, (threadsPerAgent.get(t.agentId) ?? 0) + 1);
      threadIdToAgent.set(t.id, t.agentId);
    }

    // message volume per agent (windowed)
    const messagesPerAgent = new Map<string, number>();
    for (const g of msgRows) {
      const aid = threadIdToAgent.get(g.threadId);
      if (aid) messagesPerAgent.set(aid, (messagesPerAgent.get(aid) ?? 0) + g._count._all);
    }

    // all-time last active per agent
    const lastActiveByAgent = new Map<string, Date | null>();
    for (const g of lastActiveGroups) lastActiveByAgent.set(g.agentId, g._max?.updatedAt ?? null);

    // cost + tokens per agent
    const costByAgent = new Map(
      costRows.map((r) => [r.agentId, { costCents: r.costCents, totalTokens: r.inputTokens + r.outputTokens }]),
    );

    // satisfaction per agent
    const satByAgent = new Map(
      satisfactionRows.map((r) => [r.agentId, { ups: r.ups, downs: r.downs, score: r.score, total: r.total }]),
    );

    const agents = agentList.map((a) => {
      const lastActiveAt = lastActiveByAgent.get(a.id) ?? null;
      const activeInWindow = lastActiveAt !== null && lastActiveAt >= since;
      const status: "active" | "idle" | "disabled" = !a.isActive
        ? "disabled"
        : activeInWindow
          ? "active"
          : "idle";
      const cost = costByAgent.get(a.id);
      const sat = satByAgent.get(a.id);
      return {
        agentId: a.id,
        name: a.name,
        status,
        threads: threadsPerAgent.get(a.id) ?? 0,
        messages: messagesPerAgent.get(a.id) ?? 0,
        costCents: cost?.costCents ?? 0,
        totalTokens: cost?.totalTokens ?? 0,
        satisfaction: sat && sat.total > 0 ? { ups: sat.ups, downs: sat.downs, score: sat.score } : null,
        lastActiveAt: lastActiveAt ? lastActiveAt.toISOString() : null,
      };
    });

    // Most-active first (conversations desc), then spend as a tiebreak.
    agents.sort((a, b) => b.threads - a.threads || b.costCents - a.costCents);

    return { days, agents, fetchedAt: new Date().toISOString() };
  }

  /** PIFSP-19 — User detail: conversations grouped by agent + profile memories + risk events. */
  @Get("monitoring/users/:userId")
  async monitoringUserDetail(
    @Req() req: Request,
    @Param("userId") targetUserId: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const prisma = (this.costService as any).prisma;
    if (!prisma) return { error: "service unavailable", status: 503 };

    const cost7dSince = new Date(Date.now() - 7 * 86_400_000);
    const cost30dSince = new Date(Date.now() - 30 * 86_400_000);

    // Threads for this user
    const threads: Array<{
      id: string;
      agentId: string;
      title: string | null;
      createdAt: Date;
      updatedAt: Date;
      status: string;
    }> = await prisma.platosAgentThread.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: targetUserId,
      },
      select: { id: true, agentId: true, title: true, createdAt: true, updatedAt: true, status: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });

    // Agent names
    const agentIds = [...new Set(threads.map((t) => t.agentId))];
    const agentRows: Array<{ id: string; name: string }> = await prisma.platosAgent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, name: true },
    });
    const agentNameMap = new Map(agentRows.map((a) => [a.id, a.name]));

    // Group threads by agentId
    const byAgent = new Map<string, typeof threads>();
    for (const t of threads) {
      const arr = byAgent.get(t.agentId) ?? [];
      arr.push(t);
      byAgent.set(t.agentId, arr);
    }
    const conversationsByAgent = agentIds.map((agentId) => ({
      agentId,
      agentName: agentNameMap.get(agentId) ?? agentId,
      threads: (byAgent.get(agentId) ?? []).map((t) => ({
        threadId: t.id,
        title: t.title,
        createdAt: t.createdAt.toISOString(),
        lastActiveAt: t.updatedAt.toISOString(),
        status: t.status,
      })),
    }));

    // Profile memories
    const profileMemories: Array<{ id: string; kind: string; content: string; metadata: any; createdAt: Date }> =
      await prisma.platosMemory.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          userId: targetUserId,
          kind: "profile",
        },
        select: { id: true, kind: true, content: true, metadata: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      }).catch(() => []);

    // Risk events (7d)
    const riskEvents = await this.safetyEventService.list(this.scopeTuple(scope), {
      userId: targetUserId,
      limit: 50,
    });

    // Cost
    const cost7dRows = await this.costService.getCostByUser(this.scopeTuple(scope), { days: 7, limit: 500 });
    const cost30dRows = await this.costService.getCostByUser(this.scopeTuple(scope), { days: 30, limit: 500 });
    const cost7dCents = cost7dRows.find((r) => r.userId === targetUserId)?.costCents ?? 0;
    const cost30dCents = cost30dRows.find((r) => r.userId === targetUserId)?.costCents ?? 0;

    // PlatosEndUser metadata
    const endUserRow: { displayName: string | null; email: string | null } | null =
      await (prisma as any).platosEndUser.findFirst({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          externalUserId: targetUserId,
        },
        select: { displayName: true, email: true },
      }).catch(() => null);

    // Ratings summary
    // PlatosMessageRating has direct scope + userId columns — no relation needed.
    const ratings: Array<{ rating: number }> = await prisma.platosMessageRating.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: targetUserId,
      },
      select: { rating: true },
    }).catch(() => []);
    const ratingsUps = ratings.filter((r) => r.rating > 0).length;
    const ratingsDowns = ratings.filter((r) => r.rating < 0).length;

    // Memory count by kind
    const memoryCounts: Array<{ kind: string; _count: { id: number } }> =
      await prisma.platosMemory.groupBy({
        by: ["kind"],
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          userId: targetUserId,
        },
        _count: { id: true },
      }).catch(() => []);
    const memoryBreakdown: Record<string, number> = Object.fromEntries(
      memoryCounts.map((r) => [r.kind, r._count.id]),
    );

    // Per-agent breakdown
    const perAgentBreakdown = conversationsByAgent.map((group) => ({
      agentId: group.agentId,
      agentName: group.agentName,
      conversations: group.threads.length,
    }));

    return {
      userId: targetUserId,
      displayName: endUserRow?.displayName ?? null,
      email: endUserRow?.email ?? null,
      conversationsByAgent,
      profileMemories: profileMemories.map((m) => ({
        id: m.id,
        content: m.content,
        metadata: m.metadata,
        createdAt: m.createdAt.toISOString(),
      })),
      riskEvents: riskEvents.rows.map((e) => ({
        kind: e.detector,
        at: e.createdAt,
        detail: e.detail ?? null,
        severity: e.severity,
        action: e.action,
      })),
      cost7dCents,
      cost30dCents,
      ratingsUps,
      ratingsDowns,
      memoryBreakdown,
      perAgentBreakdown,
    };
  }

  /**
   * PRELAUNCH-A3-1 — per-user consumption summary for the Users monitoring
   * drawer. Returns aggregated cap progress + breach state + live
   * rate-limit counters for `userId` within the current scope.
   */
  @Get("monitoring/users/:userId/consumption")
  async monitoringUserConsumption(
    @Req() req: Request,
    @Param("userId") targetUserId: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    return this.budgetService.getUserConsumptionSummary(scope, targetUserId);
  }

  /**
   * PRELAUNCH-A3-3 — admin endpoint listing every (cap, userId) tuple
   * currently breached (>= 100% utilisation). Powers the Governance
   * "Currently breached users" panel.
   */
  @Get("monitoring/breaches")
  async monitoringBreaches(@Req() req: Request) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    // Active userIds in the period — derive from the per-user cost rollup
    // (anyone who spent ≥1 cent in the last 30 days).
    let activeUserIds: string[] = [];
    try {
      const byUser = await this.costService.getCostByUser(scope, { days: 30, limit: 500 });
      activeUserIds = byUser.map((u) => u.userId).filter(Boolean);
    } catch {
      activeUserIds = [];
    }
    const breaches = await this.budgetService.listBreachedUsers(scope, activeUserIds);
    return { breaches, fetchedAt: new Date().toISOString() };
  }

  /** Monitoring — generate an AI summary for a user via Claude Haiku. */
  @Post("monitoring/users/:userId/summary")
  async monitoringUserSummary(
    @Req() req: Request,
    @Param("userId") targetUserId: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const prisma = (this.costService as any).prisma;
    if (!prisma) return { error: "service unavailable" };

    // Collect compact data for the prompt
    const [threads, memories, safetyRows] = await Promise.all([
      prisma.platosAgentThread.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          userId: targetUserId,
        },
        select: { id: true, agentId: true, title: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 50,
      }),
      prisma.platosMemory.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          userId: targetUserId,
        },
        select: { kind: true, content: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      prisma.platosSafetyEvent.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          userId: targetUserId,
        },
        select: { detector: true, severity: true, detail: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 10,
      }).catch(() => []),
    ]);

    // Cost data
    const costRows = await this.costService.getCostByUser(this.scopeTuple(scope), { days: 30, limit: 500 });
    const cost30d = costRows.find((r) => r.userId === targetUserId)?.costCents ?? 0;

    // Resolve Anthropic key
    const anthropicKey = await this.agentService.resolvePublicApiKey(this.scopeTuple(scope), "anthropic");
    if (!anthropicKey) {
      return {
        error: "Anthropic provider not configured for this environment. Add an Anthropic API key under Providers to enable AI summaries.",
      };
    }

    // Build compact context
    const agentIds = [...new Set((threads as Array<{ agentId: string }>).map((t) => t.agentId))];
    const agentRows: Array<{ id: string; name: string }> = await prisma.platosAgent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, name: true },
    });
    const agentNames = new Map(agentRows.map((a: { id: string; name: string }) => [a.id, a.name]));

    const memoryLines = (memories as Array<{ kind: string; content: string }>)
      .map((m) => `[${m.kind}] ${m.content.slice(0, 120)}`)
      .join("\n");
    const conversationLines = (threads as Array<{ title: string | null; agentId: string; updatedAt: Date }>)
      .slice(0, 20)
      .map(
        (t) =>
          `- "${t.title ?? "untitled"}" with agent "${agentNames.get(t.agentId) ?? t.agentId}" (${new Date(t.updatedAt).toLocaleDateString()})`,
      )
      .join("\n");
    const safetyLines =
      (safetyRows as Array<{ severity: string; detector: string; detail: string | null }>).length > 0
        ? (safetyRows as Array<{ severity: string; detector: string; detail: string | null }>)
            .map((s) => `[${s.severity}] ${s.detector}: ${s.detail ?? ""}`.trim())
            .join("\n")
        : "None";

    const prompt = `You are an analytics assistant for a managed AI agent platform. Summarise this end-user's activity for the operator. Be concise, objective, and useful. 3-5 short paragraphs.

USER ID: ${targetUserId}
TOTAL CONVERSATIONS (last 30d): ${(threads as any[]).length}
AGENTS INTERACTED WITH: ${agentIds.length} (${agentRows.map((a) => a.name).join(", ")})
COST (30d): $${(cost30d / 100).toFixed(4)}
MEMORIES RECORDED:
${memoryLines || "None"}
RECENT CONVERSATIONS:
${conversationLines || "None"}
SAFETY / RISK EVENTS:
${safetyLines}

Write the summary now:`;

    try {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const { generateText } = await import("ai");
      const anthropicClient = createAnthropic({ apiKey: anthropicKey });
      // PRELAUNCH-A2-12 — propagate the inbound HTTP request's abort
      // signal so a client disconnect cancels the upstream LLM call.
      // `req.signal` is the standard Web AbortSignal exposed on the
      // Express Request under Node 18+. Without this, an admin who
      // navigates away mid-summary keeps Anthropic billing.
      const reqSignal = (req as unknown as { signal?: AbortSignal }).signal;
      const { text } = await generateText({
        model: anthropicClient("claude-haiku-4-5-20251001"),
        messages: [{ role: "user", content: prompt }],
        maxOutputTokens: 600,
        temperature: 0.3,
        abortSignal: reqSignal,
      });
      return { summary: text.trim(), generatedAt: new Date().toISOString() };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown error";
      return { error: `Summary generation failed: ${msg}` };
    }
  }

  /**
   * MC.4 — per-agent cache hit rate time series.
   *
   * Reads Redis per-agent daily counters (`cost:agent:<scope>:<agentId>:<day>`)
   * and returns a per-day series of input / output / cache-write / cache-read
   * tokens plus naive + cache-adjusted cost. Powers the "Cache hit rate"
   * sparkline on the per-agent page. Default window = 7 days.
   *
   * Fail-graceful — a fresh agent with no recorded traffic returns an
   * all-zero shape; the UI renders a neutral "no cache activity yet"
   * state rather than an error.
   */
  @Get("monitoring/agent/:agentId/cache-range")
  async agentCacheRange(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Query("days") daysRaw?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const days = Math.max(1, Math.min(30, daysRaw ? parseInt(daysRaw, 10) || 7 : 7));
    const result = await this.costService.getAgentCacheRange(
      this.scopeTuple(scope),
      agentId,
      days,
    );
    return { agentId, days, ...result, fetchedAt: new Date().toISOString() };
  }

  /**
   * SM.2 — skill usage daily breakdown.
   *
   * Returns per-skill / per-tool / per-agent / per-provider totals for a
   * single day. Fail-graceful: a scope with no recorded skill events
   * returns empty arrays (not 500).
   */
  @Get("monitoring/cost/skills/daily")
  async skillCostDaily(
    @Req() req: Request,
    @Query("date") date?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const result = await this.costService.getSkillCostDaily(this.scopeTuple(scope), date);
    return { ...result, fetchedAt: new Date().toISOString() };
  }

  /**
   * SM.2 — skill usage range breakdown. `from` / `to` are inclusive
   * YYYY-MM-DD strings; window is capped at 92 days.
   */
  @Get("monitoring/cost/skills/range")
  async skillCostRange(
    @Req() req: Request,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const today = new Date().toISOString().slice(0, 10);
    const end = to || today;
    // Default to a 7-day window ending today when no `from` given.
    const defaultFrom = new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10);
    const start = from || defaultFrom;
    const result = await this.costService.getSkillCostRange(
      this.scopeTuple(scope),
      start,
      end,
    );
    return { ...result, fetchedAt: new Date().toISOString() };
  }

  /**
   * Top users + utilization trends (active threads, messages/day, new vs
   * returning). All queries scope-filtered. Theme E.4.
   */
  @Get("monitoring/top-users")
  async topUsers(
    @Req() req: Request,
    @Query("days") days?: string,
    @Query("limit") limit?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    return this.utilizationService.build(this.scopeTuple(scope), {
      days: days ? parseInt(days, 10) : undefined,
      topUserLimit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /**
   * Utilization-only payload — same builder but clear in intent when the
   * UI wants activity metrics without a user leaderboard. Theme E.4.
   */
  @Get("monitoring/utilization")
  async utilization(
    @Req() req: Request,
    @Query("days") days?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    return this.utilizationService.build(this.scopeTuple(scope), {
      days: days ? parseInt(days, 10) : undefined,
    });
  }

  /**
   * Tool-call audit list. Theme E.5.
   * One row per dispatched tool call — scope-filtered, newest first.
   *
   * Query params (all optional):
   *   - threadId, agentId, toolName, status, entityId — equality filters
   *   - sinceDays (default 30) — time window
   *   - limit (default 50, max 200) / offset — pagination
   */
  @Get("monitoring/tool-audit")
  async listToolAudit(
    @Req() req: Request,
    @Query("threadId") threadId?: string,
    @Query("agentId") agentId?: string,
    @Query("toolName") toolName?: string,
    @Query("status") status?: string,
    @Query("entityId") entityId?: string,
    @Query("sinceDays") sinceDays?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const page = await this.toolAuditService.list(this.scopeTuple(scope), {
      threadId,
      agentId,
      toolName,
      status,
      entityId,
      sinceDays: sinceDays ? parseInt(sinceDays, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
    return { ...page, fetchedAt: new Date().toISOString() };
  }

  /**
   * Fetch a single tool-call audit row for drilldown. Scope-gated.
   * Theme E.5.
   */
  @Get("monitoring/tool-audit/:callId")
  async getToolAudit(@Req() req: Request, @Param("callId") callId: string) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const row = await this.toolAuditService.getById(this.scopeTuple(scope), callId);
    if (!row) return { error: "Tool call not found", status: 404 };
    return row;
  }

  /**
   * Replay a prior tool call. Theme E.5.
   *
   * Loads the audit row inside the requesting scope — a cross-scope id
   * returns 404 — then re-invokes the tool with the identical original args
   * via ToolExecutorService. The tool name is routed through the scoped
   * registry, so replay cannot hit a different entity or leak into another
   * env; it goes through the same HMAC-signed path as a live call.
   *
   * Response shape is `{ original, replay }` so the UI can diff the two
   * results side by side. The replay itself appends its own audit row.
   */
  @Post("monitoring/tool-audit/:callId/replay")
  async replayToolAudit(
    @Req() req: Request,
    @Param("callId") callId: string,
  ): Promise<any> {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard

    // PPR-10 — per-(scope, user) token bucket: 10 replays per minute.
    // Replay re-invokes through ToolExecutorService.execute which runs
    // against the live entity (each call is billable). Without a cap, any
    // valid-scope session could issue unbounded billable replays.
    const rateLimitKey = `replay:rate:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${scope.userId}`;
    const REPLAY_WINDOW_SECONDS = 60;
    const REPLAY_BUDGET = 10;
    const current = await this.redis.incr(rateLimitKey);
    if (current === 1) {
      await this.redis.expire(rateLimitKey, REPLAY_WINDOW_SECONDS);
    }
    if (current > REPLAY_BUDGET) {
      const ttl = await this.redis.ttl(rateLimitKey);
      return {
        error: "rate_limited",
        message: `Replay budget exceeded: ${REPLAY_BUDGET} per ${REPLAY_WINDOW_SECONDS}s. Retry in ${Math.max(ttl, 1)}s.`,
        retryAfterSeconds: Math.max(ttl, 1),
        status: 429,
      };
    }

    const original = await this.toolAuditService.getById(this.scopeTuple(scope), callId);
    if (!original) return { error: "Tool call not found", status: 404 };

    // Replay uses the SAME scope from the current request — not the original
    // row's scope. Because getById already proved the original row belongs
    // to (scope.org, scope.project, scope.env), these are equivalent here.
    // We keep the dispatch inside the requesting scope for defence in depth:
    // a stolen audit id cannot be used to impersonate another scope.
    const replayResult = await this.toolExecutor.execute(
      {
        tool: original.toolName,
        params: (original.args as Record<string, unknown>) ?? {},
        purpose: "replay",
      },
      scope,
    );

    return {
      original,
      replay: replayResult,
      replayedAt: new Date().toISOString(),
    };
  }

  /**
   * HITL approval queue. Theme E.6.
   *
   * Lists every `request_approval` / `cancel_run` waitpoint the agent
   * runtime opened in the current (org, project, env) scope — including
   * pending, approved, rejected, timed_out. Each row carries its SLA
   * clock (`secondsRemaining`, `expired`, `deadlineAt`) computed
   * server-side against `(createdAt + timeoutSeconds)` so the UI renders
   * a live countdown without additional math.
   *
   * Query params (all optional):
   *   - agentId, threadId, status, source — equality filters
   *   - sinceDays (default 30) — time window
   *   - limit (default 50, max 200) / offset — pagination
   *
   * The service opportunistically sweeps pending rows that have crossed
   * their timeout into `timed_out` status on every list call, so the
   * governance dashboard never stalls on ghost rows from a crashed agent
   * process.
   */
  @Get("monitoring/approvals")
  async listApprovals(
    @Req() req: Request,
    @Query("threadId") threadId?: string,
    @Query("agentId") agentId?: string,
    @Query("status") status?: string,
    @Query("source") source?: string,
    @Query("sinceDays") sinceDays?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const scopeTuple = this.scopeTuple(scope);
    // Note: previously this called `sweepExpired` synchronously on every
    // request. The webapp polls this endpoint every ~2s for the pending-
    // approvals badge — under concurrent polls the per-call UPDATE caused
    // 100s+ p99 latency from row-lock contention. The scheduled trigger.dev
    // task `platos.approvals.expiry_sweep` (5-min cadence) is the canonical
    // sweep path; the BLPOP timeout branch in `request_approval` writes
    // `timed_out` directly. The list call below tolerates a few seconds of
    // stale `pending` rows in exchange for fast polling.
    const page = await this.approvalsService.list(scopeTuple, {
      threadId,
      agentId,
      status,
      source,
      sinceDays: sinceDays ? parseInt(sinceDays, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
    return { ...page, fetchedAt: new Date().toISOString() };
  }

  /** Fetch a single approval row — scope-gated. Theme E.6. */
  @Get("monitoring/approvals/:approvalId")
  async getApproval(@Req() req: Request, @Param("approvalId") approvalId: string) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const row = await this.approvalsService.getById(this.scopeTuple(scope), approvalId);
    if (!row) return { error: "Approval not found", status: 404 };
    return row;
  }

  /**
   * LAUNCH-11 — internal compaction endpoint. Called back by the
   * `platos.compaction` trigger.dev task with `{threadId, scope}`.
   * Resolves the agent config for the thread + delegates to
   * `AgentTaskService.runCompaction`.
   *
   * Gated by `X-Platos-Admin-Token` (same gate as other internal callbacks).
   * The task already verified the token at dispatch time but we re-verify
   * here so a leaked URL alone can't trigger compactions.
   */
  @Post("internal/compaction")
  async internalCompaction(
    @Req() req: Request,
    @Body() body: {
      threadId: string;
      scope: {
        organizationId: string;
        projectId: string;
        environmentId: string;
        userId: string;
        agentId?: string | null;
      };
    },
  ) {
    const expected = env.PLATOS_ADMIN_TOKEN;
    if (!expected) {
      return { status: "skipped", reason: "PLATOS_ADMIN_TOKEN not set" };
    }
    const provided = req.headers["x-platos-admin-token"];
    const isValid =
      typeof provided === "string" &&
      provided.length === expected.length &&
      (() => {
        try {
          return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
        } catch {
          return false;
        }
      })();
    if (!isValid) {
      return { status: "forbidden" };
    }
    if (!body?.threadId || !body?.scope) {
      return { status: "invalid", reason: "threadId and scope required" };
    }
    // SECURITY (audit C2 / Fable BLOCKER B residual) — the body's scope must
    // own the thread (compaction runs under the supplied scope). threadId is
    // mandatory here so no omit-ids hole, but the ownership was unverified.
    if (!(await this.adminCallbackScopeOwns(body))) {
      return { status: "forbidden", reason: "scope does not own the target thread" };
    }
    const start = Date.now();
    try {
      // Resolve agent config from the thread's agentId. Compaction needs
      // historyMode + contextLimit + compactThreshold from the agent.
      const agentId = body.scope.agentId;
      let config: any = { historyMode: "compact", contextLimit: 30, compactThreshold: 40 };
      if (agentId) {
        const resolved = await (this.agentTaskService as any).resolveConfigForThread?.(agentId, body.threadId, body.scope);
        if (resolved) config = resolved;
      }
      await this.agentTaskService.runCompaction(body.threadId, body.scope as any, config);
      return {
        status: "ok",
        threadId: body.threadId,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        status: "failed",
        reason: err?.message ?? String(err),
        threadId: body.threadId,
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * REFACTOR (control-plane + trigger substrate) — shared admin-token gate
   * for the durable-execution callbacks below. Timing-safe; mirrors the
   * inline check in internalCompaction. Tasks already verify at dispatch;
   * we re-verify so a leaked URL alone can't drive turns.
   */
  private verifyAdminToken(req: Request): boolean {
    const expected = env.PLATOS_ADMIN_TOKEN;
    if (!expected) return false;
    const provided = req.headers["x-platos-admin-token"];
    if (typeof provided !== "string" || provided.length !== expected.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  /**
   * Close durable chat sessions whose conversation is done (archived, idle,
   * orphaned, or past max age). Invoked by the `platos.chat.session_reaper`
   * scheduled task — the task has no Prisma/Redis, so it delegates here.
   * Admin-token gated. Never throws: returns the sweep summary.
   */
  @Post("internal/chat/reap-sessions")
  async internalChatReapSessions(@Req() req: Request, @Res() res: Response) {
    if (!env.PLATOS_ADMIN_TOKEN) {
      res.status(503).json({ error: "PLATOS_ADMIN_TOKEN not set" });
      return;
    }
    if (!this.verifyAdminToken(req)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    try {
      const result = await this.conversationService.reapChatSessions();
      res.status(200).json(result);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "reap failed" });
    }
  }

  /**
   * REFACTOR — durable agent turn callback. Invoked by the
   * `platos.agent.durable-turn` trigger task when an agent's
   * executionMode==="durable". Runs one turn in-process (reusing the same
   * executeNonStreamingTurn path as batch-turn) against the supplied thread
   * so conversation history + persistence are unchanged. Admin-token gated.
   */
  @Post("internal/durable-turn")
  async internalDurableTurn(
    @Req() req: Request,
    @Body() body: {
      threadId: string;
      agentId: string;
      message: string;
      replyToMessageId?: string | null;
      clientMessageId?: string | null;
      scope: {
        organizationId: string;
        projectId: string;
        environmentId: string;
        userId: string;
        agentId?: string;
        threadId?: string;
      };
    },
  ) {
    if (!env.PLATOS_ADMIN_TOKEN) return { status: "skipped", reason: "PLATOS_ADMIN_TOKEN not set" };
    if (!this.verifyAdminToken(req)) return { status: "forbidden" };
    if (!body?.message || !body?.scope) return { status: "invalid", reason: "message and scope required" };
    // SECURITY (audit C2) — the body's scope must own its agent/thread.
    if (!(await this.adminCallbackScopeOwns(body))) {
      return { status: "forbidden", reason: "scope does not own the target agent/thread" };
    }
    const start = Date.now();
    const threadId = body.threadId;
    const room = `thread:${threadId}`;
    try {
      // Run the turn in-process and RELAY each stream event to the thread room via
      // the gateway's generic Redis forwarder (`overview:event` → server.to(room).emit).
      // The durable-dispatch path (connections.gateway) joins the client socket to
      // `thread:<id>` before triggering this task, so the reply streams to the chat
      // exactly like the direct path — durability is transparent to the client.
      let fullText = "";
      let messageId: string | undefined;
      let costCents = 0;
      for await (const event of this.agentTaskService.executeStreamingTurn(body.message, body.scope as any, {
        agentId: body.agentId,
        threadId: body.threadId,
        replyToMessageId: body.replyToMessageId ?? undefined,
        idempotencyKey: body.clientMessageId ?? undefined,
      })) {
        this.redis
          .publish("overview:event", JSON.stringify({ room, event: "agent_event", data: { ...event, threadId } }))
          .catch(() => undefined);
        if (event.type === "token") fullText += (event as any).text ?? "";
        else if ((event as any).type === "message_persisted") {
          messageId = (event as any).messageId;
          costCents = (event as any).costCents ?? costCents;
        }
      }
      return {
        status: "ok" as const,
        threadId,
        text: fullText,
        messageId,
        costCents,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      // Surface the failure to the chat client too so a durable turn never hangs silently.
      this.redis
        .publish(
          "overview:event",
          JSON.stringify({ room, event: "agent_event", data: { type: "error", message: err?.message ?? String(err), threadId } }),
        )
        .catch(() => undefined);
      return {
        status: "failed" as const,
        reason: err?.message ?? String(err),
        threadId,
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * REFACTOR (Trigger Sessions — Option 1, Platos proxies) — SSE turn for the
   * durable chat-session worker. The `platos.chat.session` `chat.customAgent`
   * worker POSTs here once per turn; we run the EXISTING
   * `executeStreamingTurn` (config, BYOK key, tools, memory, cost, scope,
   * persistence are ALL reused — no reimplementation in the worker) and stream
   * its AgentStreamEvents back as SSE. The worker converts each event to a
   * UIMessageChunk and writes it to the durable Trigger session `.out`; Platos
   * then proxies `.out` to the chat client. Mirrors `agentChatStream` (SSE +
   * heartbeat) with the admin-token + body-scope gate of `internalDurableTurn`
   * (this is called by the Trigger worker through the public proxy, not a
   * browser). See docs/durable-chat-sessions-migration-plan.md.
   */
  @Post("internal/chat/stream-turn")
  async internalChatStreamTurn(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: {
      threadId: string;
      agentId: string;
      message: string;
      replyToMessageId?: string | null;
      clientMessageId?: string | null;
      scope: {
        organizationId: string;
        projectId: string;
        environmentId: string;
        userId: string;
        agentId?: string;
        threadId?: string;
      };
    },
  ) {
    if (!env.PLATOS_ADMIN_TOKEN) {
      res.status(503).json({ error: "PLATOS_ADMIN_TOKEN not set" });
      return;
    }
    if (!this.verifyAdminToken(req)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    if (!body?.message || !body?.scope) {
      res.status(400).json({ error: "message and scope required" });
      return;
    }
    // SECURITY (audit C2) — the body's scope must own its agent/thread.
    if (!(await this.adminCallbackScopeOwns(body))) {
      res.status(403).json({ error: "forbidden", reason: "scope does not own the target agent/thread" });
      return;
    }
    const ac = new AbortController();
    const onClose = () => {
      if (!ac.signal.aborted) ac.abort();
    };
    req.on("close", onClose);
    res.on("close", onClose);
    const rawEvents = this.agentTaskService.executeStreamingTurn(body.message, body.scope as any, {
      agentId: body.agentId,
      threadId: body.threadId,
      replyToMessageId: body.replyToMessageId ?? undefined,
      idempotencyKey: body.clientMessageId ?? undefined,
      abortSignal: ac.signal,
    });
    const heartbeatMs = Math.max(1000, env.PLATOS_STREAM_HEARTBEAT_MS ?? 15_000);
    const events = withHeartbeat(rawEvents, { intervalMs: heartbeatMs, signal: ac.signal });
    await this.streamingService.streamToSSE(events, res);
  }

  /**
   * REFACTOR — AI-employee run callback. Invoked by the
   * `platos.agent.employee-run` trigger task. Multi-step autonomous
   * orchestration (sub-turns, tools, waitpoints) is a follow-up; this initial
   * implementation runs a single durable turn seeded with the goal — a
   * correct (if degenerate) employee run that unblocks the task path.
   * Admin-token gated.
   */
  @Post("internal/employee-run")
  async internalEmployeeRun(
    @Req() req: Request,
    @Body() body: {
      agentId: string;
      goal: string;
      input?: Record<string, unknown>;
      maxSteps?: number;
      threadId?: string;
      scope: {
        organizationId: string;
        projectId: string;
        environmentId: string;
        userId: string;
        agentId?: string;
      };
    },
  ) {
    if (!env.PLATOS_ADMIN_TOKEN) return { status: "skipped", reason: "PLATOS_ADMIN_TOKEN not set" };
    if (!this.verifyAdminToken(req)) return { status: "forbidden" };
    if (!body?.goal || !body?.scope) return { status: "invalid", reason: "goal and scope required" };
    // SECURITY (audit C2 / Fable BLOCKER B) — the body's scope must own its agent/thread.
    if (!(await this.adminCallbackScopeOwns(body))) {
      return { status: "forbidden", reason: "scope does not own the target agent/thread" };
    }
    const start = Date.now();
    try {
      // TODO(refactor): multi-step autonomous orchestration. For now a single
      // goal-seeded durable turn (see IMPLEMENTATION-STATUS.md).
      const result = await this.agentTaskService.executeNonStreamingTurn(body.goal, body.scope as any, {
        agentId: body.agentId,
        threadId: body.threadId,
      });
      return {
        status: "ok" as const,
        agentId: body.agentId,
        threadId: result.threadId ?? body.threadId,
        summary: result.text,
        steps: 1,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        status: "failed" as const,
        reason: err?.message ?? String(err),
        agentId: body.agentId,
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * REFACTOR — skill-as-task callback. Invoked by the `platos.skill.run`
   * trigger task to execute a heavy/parallel/long skill tool off the agent
   * event loop. Runs the skill handler in-scope via SkillRuntimeService.
   * Admin-token gated.
   */
  @Post("internal/skill-run")
  async internalSkillRun(
    @Req() req: Request,
    @Body() body: {
      skillId: string;
      toolName: string;
      input?: Record<string, unknown>;
      threadId?: string;
      scope: {
        organizationId: string;
        projectId: string;
        environmentId: string;
        userId: string;
        agentId?: string;
        threadId?: string;
      };
    },
  ) {
    if (!env.PLATOS_ADMIN_TOKEN) return { status: "skipped", reason: "PLATOS_ADMIN_TOKEN not set" };
    if (!this.verifyAdminToken(req)) return { status: "forbidden" };
    if (!body?.skillId || !body?.toolName || !body?.scope) {
      return { status: "invalid", reason: "skillId, toolName and scope required" };
    }
    // SECURITY (audit C2 / Fable BLOCKER B) — the body's scope must own its
    // agent/thread. skill-run carries the agent id inside scope.agentId.
    if (
      !(await this.adminCallbackScopeOwns({
        agentId: body.scope?.agentId,
        threadId: body.threadId ?? body.scope?.threadId,
        scope: body.scope,
      }))
    ) {
      return { status: "forbidden", reason: "scope does not own the target agent/thread" };
    }
    if (!this.skillRuntime) return { status: "skipped", reason: "SkillRuntimeService unavailable" };
    const start = Date.now();
    try {
      const result = await this.skillRuntime.invokeTool(
        body.scope as any,
        {
          skillSlug: body.skillId,
          toolName: body.toolName,
          handler: `skill:${body.skillId}:${body.toolName}`,
        },
        body.input ?? {},
        { agentId: body.scope.agentId ?? null, threadId: body.threadId ?? body.scope.threadId ?? null },
      );
      return {
        status: "ok" as const,
        skillId: body.skillId,
        toolName: body.toolName,
        result,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        status: "failed" as const,
        reason: err?.message ?? String(err),
        skillId: body.skillId,
        toolName: body.toolName,
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * Admin: ingest a refreshed LiteLLM model-price catalog. Called by the
   * scheduled `platos.cost.refresh_model_prices` trigger task once per
   * day. Gated by `X-Platos-Admin-Token` so external callers can't spoof
   * prices.
   */
  @Post("monitoring/cost/catalog")
  async ingestCostCatalog(
    @Req() req: Request,
    @Body() body: { catalog: Record<string, Record<string, unknown>> },
  ) {
    const expected = env.PLATOS_ADMIN_TOKEN;
    if (!expected) {
      return { status: "skipped", reason: "PLATOS_ADMIN_TOKEN not set" };
    }
    // PPR-14: timing-safe compare to prevent brute-force token recovery
    // via response-time analysis. `!==` / `===` compares byte-by-byte with
    // early exit, leaking position of first differing byte.
    const provided = req.headers["x-platos-admin-token"];
    const isValid =
      typeof provided === "string" &&
      provided.length === expected.length &&
      (() => {
        try {
          return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
        } catch {
          return false;
        }
      })();
    if (!isValid) {
      return { status: "forbidden" };
    }
    if (!body?.catalog || typeof body.catalog !== "object") {
      return { status: "invalid", reason: "catalog missing" };
    }
    await this.costService.ingestCatalog(body.catalog as any);
    return { status: "ok", modelCount: Object.keys(body.catalog).length };
  }

  /**
   * EOBD.100 — DLQ drain endpoint. Scheduled
   * `platos.observability.dlq_drain` task POSTs here every 2 min. We
   * pop up to `maxBatch` entries off the Redis list, attempt re-insert,
   * and count per-DLQ successes + permanent failures. Permanent
   * failures (after N internal attempts) move to a `:dead` list for
   * manual operator review.
   */
  @Post("monitoring/dlq/drain")
  async drainDlq(
    @Req() req: Request,
    @Body() body: { maxBatch?: number } = {},
  ) {
    const expected = env.PLATOS_ADMIN_TOKEN;
    if (!expected) {
      return { status: "skipped", reason: "PLATOS_ADMIN_TOKEN not set" };
    }
    const provided = req.headers["x-platos-admin-token"];
    const isValid =
      typeof provided === "string" &&
      provided.length === expected.length &&
      (() => {
        try {
          return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
        } catch {
          return false;
        }
      })();
    if (!isValid) {
      return { status: "forbidden" };
    }

    const maxBatch = Math.min(5_000, Math.max(1, body?.maxBatch ?? 500));
    const drained: { spans: number; cost: number } = { spans: 0, cost: 0 };
    const deadLettered: { spans: number; cost: number } = { spans: 0, cost: 0 };

    // Delegate to the services so the retry logic stays colocated with
    // the original write path. Each service exposes a small helper that
    // reads maxBatch off the Redis list + retries; our job is just
    // orchestration + audit.
    try {
      const spanResult = await this.spansService.drainDlq(maxBatch).catch(() => ({
        retried: 0,
        dead: 0,
      }));
      drained.spans = spanResult.retried;
      deadLettered.spans = spanResult.dead;
    } catch {
      /* spans DLQ drain error swallowed — next tick retries */
    }
    try {
      const costResult = await (this.costService as any).drainDlq?.(maxBatch);
      if (costResult) {
        drained.cost = costResult.retried ?? 0;
        deadLettered.cost = costResult.dead ?? 0;
      }
    } catch {
      /* cost DLQ not yet wired — tolerate */
    }

    return { status: "ok", drained, deadLettered };
  }

  /**
   * PPR-24 — Admin: rebuild Redis cost hashes from PlatosAgentMessage
   * (Postgres is authoritative). Called by the nightly
   * `platos.cost.reconcile` trigger task.
   */
  @Post("monitoring/cost/reconcile")
  async reconcileCost(@Req() req: Request, @Body() body: { daysBack?: number } = {}) {
    const expected = env.PLATOS_ADMIN_TOKEN;
    if (!expected) {
      return { status: "skipped", reason: "PLATOS_ADMIN_TOKEN not set" };
    }
    const provided = req.headers["x-platos-admin-token"];
    const isValid =
      typeof provided === "string" &&
      provided.length === expected.length &&
      (() => {
        try {
          return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
        } catch {
          return false;
        }
      })();
    if (!isValid) {
      return { status: "forbidden" };
    }
    const result = await this.costService.reconcileFromPostgres({
      daysBack: typeof body?.daysBack === "number" ? body.daysBack : undefined,
    });
    return { status: "ok", ...result, reconciledAt: new Date().toISOString() };
  }

  /**
   * PPR-67 — Admin: expire stuck-pending approvals across every scope.
   * Called every 5 minutes by the `platos.approvals.expiry_sweep` trigger
   * task. Gated by the same `X-Platos-Admin-Token` the cost catalog
   * endpoint uses.
   */
  @Post("monitoring/approvals/expiry-sweep")
  async expireApprovals(@Req() req: Request) {
    const expected = env.PLATOS_ADMIN_TOKEN;
    if (!expected) {
      return { status: "skipped", reason: "PLATOS_ADMIN_TOKEN not set" };
    }
    const provided = req.headers["x-platos-admin-token"];
    const isValid =
      typeof provided === "string" &&
      provided.length === expected.length &&
      (() => {
        try {
          return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
        } catch {
          return false;
        }
      })();
    if (!isValid) {
      return { status: "forbidden" };
    }
    const result = await this.approvalsService.sweepExpiredAllScopes();
    return { status: "ok", ...result, sweptAt: new Date().toISOString() };
  }

  /**
   * Monitoring summary — four headline cards for /agent-monitoring:
   *   - active conversations (all-time)
   *   - conversations last 24h
   *   - spend last 7 days
   *   - active tools (tools with >=1 call in last 7 days)
   *
   * The full dashboard lives in Theme E. Until then this endpoint powers
   * the initial cards + the 7-day cost sparkline.
   */
  @Get("monitoring/summary")
  async monitoringSummary(@Req() req: Request) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const scopeTuple = this.scopeTuple(scope);

    const [threadCountAll, threadCountDay, cost7d] = await Promise.all([
      (this.agentService as any).prisma.platosAgentThread.count({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
      }),
      (this.agentService as any).prisma.platosAgentThread.count({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          createdAt: { gte: new Date(Date.now() - 86400_000) },
        },
      }),
      this.costService.getScopeCostRange(scopeTuple, 7),
    ]);

    // PPR-59 — defence-in-depth scope filter. `PlatosToolHealth` only
    // stores `environmentId` + `entityId` natively — organizationId and
    // projectId live on the parent `RuntimeEnvironment` row. `environmentId`
    // alone is already globally unique (RuntimeEnvironment is the scope
    // container), so a leak would require environmentId reuse across
    // scopes — which the schema theoretically permits even if the issuer
    // never does it. Traversing the `environment` relation and re-checking
    // (org, project) makes the query's scope intent explicit and matches
    // the §5.1 "full tuple on every scoped read" invariant.
    const activeToolsRows: Array<{ totalCalls: number; lastCalledAt: Date | null }> =
      await (this.agentService as any).prisma.platosToolHealth.findMany({
        where: {
          environmentId: scope.environmentId,
          environment: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
          },
          lastCalledAt: { gte: new Date(Date.now() - 7 * 86400_000) },
        },
        select: { totalCalls: true, lastCalledAt: true },
      });

    return {
      cards: [
        {
          id: "threads_all",
          label: "Conversations (all time)",
          value: threadCountAll,
          unit: "threads",
        },
        {
          id: "threads_24h",
          label: "Conversations last 24h",
          value: threadCountDay,
          unit: "threads",
        },
        {
          id: "cost_7d",
          label: "Spend last 7 days",
          value: cost7d.costCents,
          unit: "cents",
          details: {
            inputTokens: cost7d.inputTokens,
            outputTokens: cost7d.outputTokens,
          },
        },
        {
          id: "tools_active_7d",
          label: "Active tools (7d)",
          value: activeToolsRows.length,
          unit: "tools",
        },
      ],
      costSeries: cost7d.perDay,
      fetchedAt: new Date().toISOString(),
    };
  }

  // ═══════════════════════════════════════════════════════
  // Theme H — Safety + Budget + Governance
  // ═══════════════════════════════════════════════════════

  /** Governance dashboard payload — detectors + budgets + agent risk. */
  @Get("monitoring/governance")
  async governanceDashboard(@Req() req: Request, @Query("sinceDays") sinceDaysRaw?: string) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const sinceDays = sinceDaysRaw ? parseInt(sinceDaysRaw, 10) : undefined;
    return this.governanceService.dashboard(this.scopeTuple(scope), { sinceDays });
  }

  /** List safety events for the governance timeline. */
  @Get("monitoring/safety-events")
  async listSafetyEvents(
    @Req() req: Request,
    @Query("detector") detector?: string,
    @Query("action") action?: string,
    @Query("threadId") threadId?: string,
    @Query("agentId") agentId?: string,
    @Query("userId") userId?: string,
    @Query("severity") severity?: string,
    @Query("sinceDays") sinceDays?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    return this.safetyEventService.list(this.scopeTuple(scope), {
      detector: detector as DetectorKind | undefined,
      action: action as DetectorAction | undefined,
      threadId,
      agentId,
      userId,
      severity: severity as "low" | "medium" | "high" | undefined,
      sinceDays: sinceDays ? parseInt(sinceDays, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  // ── Activity feed ─────────────────────────────────────

  /**
   * PIFSP-2 — Plato Central activity feed.
   *
   * Returns a time-sorted UNION of recent events across 5 sources:
   *   1. PlatosAgentMessage (assistant turns)
   *   2. PlatosConnectedEntity (connect/disconnect)
   *   3. PlatosMemory (extraction events, source="extractor")
   *   4. PlatosAgentVersion (version promotions)
   *   5. PlatosSafetyEvent
   * Each source is fetched independently with take=limit, then merged and
   * sorted descending in-memory. Max 50 items.
   */
  @Get("activity/recent")
  async recentActivity(
    @Req() req: Request,
    @Query("limit") limitStr?: string,
    @Query("agentId") agentId?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const prisma = (this.agentService as any).prisma;
    const limit = Math.min(50, Math.max(1, limitStr ? parseInt(limitStr, 10) : 15));
    const scopeWhere = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      ...(agentId ? { agentId } : {}),
    };

    type ActivityItem = {
      kind: string;
      at: string;
      agentId?: string;
      threadId?: string;
      userId?: string;
      summary: string;
      severity?: "info" | "warn" | "error";
      payload?: Record<string, unknown>;
    };

    const items: ActivityItem[] = [];

    // 1. Recently active threads (PlatosAgentMessage has no scope columns —
    //    scope lives on the thread; query threads instead).
    const turns = await prisma.platosAgentThread.findMany({
      where: { ...scopeWhere },
      orderBy: { updatedAt: "desc" },
      take: limit,
      select: { id: true, agentId: true, userId: true, updatedAt: true, turnCount: true },
    });
    for (const t of turns) {
      items.push({
        kind: "turn.completed",
        at: t.updatedAt.toISOString(),
        agentId: t.agentId,
        threadId: t.id,
        userId: t.userId ?? undefined,
        summary: `Thread active · ${t.turnCount} turn${t.turnCount !== 1 ? "s" : ""}`,
        severity: "info",
        payload: { turnCount: t.turnCount },
      });
    }

    // 2. Entity connect/disconnect (recent updates)
    const entities = await prisma.platosConnectedEntity.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        ...(agentId ? {} : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
      select: { entityId: true, updatedAt: true, lastConnectedAt: true },
    });
    for (const e of entities) {
      const connected = !!e.lastConnectedAt &&
        Math.abs(new Date(e.updatedAt).getTime() - new Date(e.lastConnectedAt).getTime()) < 5000;
      items.push({
        kind: connected ? "entity.connected" : "entity.disconnected",
        at: e.updatedAt.toISOString(),
        summary: `Entity ${e.entityId} ${connected ? "connected" : "disconnected"}`,
        severity: "info",
        payload: { entityId: e.entityId },
      });
    }

    // 3. Memory extraction events
    const memories = await prisma.platosMemory.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        source: "extractor",
        ...(agentId ? { agentId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { agentId: true, createdAt: true, kind: true },
    });
    for (const m of memories) {
      items.push({
        kind: "memory.extracted",
        at: m.createdAt.toISOString(),
        agentId: m.agentId ?? undefined,
        summary: `Memory extracted · ${m.kind}`,
        severity: "info",
        payload: { kind: m.kind },
      });
    }

    // 4. Agent version promotions.
    // PlatosAgentVersion has no scope columns of its own — scope through the
    // `agent` relation (PlatosAgent owns organizationId/projectId/environmentId).
    const versions = await prisma.platosAgentVersion.findMany({
      where: {
        agent: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        ...(agentId ? { agentId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { agentId: true, createdAt: true, versionNumber: true },
    });
    for (const v of versions) {
      items.push({
        kind: "version.promoted",
        at: v.createdAt.toISOString(),
        agentId: v.agentId,
        summary: `Agent version v${v.versionNumber} created`,
        severity: "info",
        payload: { versionNumber: v.versionNumber },
      });
    }

    // 5. Safety events
    const safety = await prisma.platosSafetyEvent.findMany({
      where: { ...scopeWhere },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { agentId: true, threadId: true, createdAt: true, kind: true, severity: true, detector: true },
    }).catch(() => []);
    for (const s of safety) {
      items.push({
        kind: "safety.event",
        at: s.createdAt.toISOString(),
        agentId: s.agentId ?? undefined,
        threadId: s.threadId ?? undefined,
        summary: `Safety event · ${s.kind} (${s.severity})`,
        severity: s.severity === "high" ? "error" : s.severity === "medium" ? "warn" : "info",
        payload: { kind: s.kind, severity: s.severity, detector: s.detector },
      });
    }

    // Sort all merged items desc by time, cap at limit
    items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return { items: items.slice(0, limit), fetchedAt: new Date().toISOString() };
  }

  // ── Budget caps ────────────────────────────────────────

  /** List every budget cap configured for the current scope. */
  @Get("budgets")
  async listBudgets(@Req() req: Request) {
    const scope = this.getScope(req);
    const caps = await this.budgetService.list(this.scopeTuple(scope));
    return { caps };
  }

  /**
   * Live status for every cap — spent/limit + threshold state. Unlike the
   * dashboard aggregator, this endpoint only hits the budget subsystem so
   * it's cheap to poll.
   */
  @Get("budgets/status")
  async budgetStatus(
    @Req() req: Request,
    @Query("agentId") agentId?: string,
    @Query("userId") userId?: string,
  ) {
    const scope = this.getScope(req);
    return this.budgetService.evaluate(this.scopeTuple(scope), {
      agentId: agentId || undefined,
      userId: userId || scope.userId,
    });
  }

  /** Create or update a budget cap (upsert on scope+target+period). */
  @Post("budgets")
  async upsertBudget(
    @Req() req: Request,
    @Body()
    body: {
      scopeType: BudgetScopeType;
      targetId?: string;
      period: BudgetPeriod;
      limitCents: number;
      runsLimit?: number;
      alertThresholds?: number[];
      alertWebhookUrl?: string | null;
      alertEmails?: string | null;
      enabled?: boolean;
      // Theme SM.4 — tier/skill/agent filters. Forwarded as-is to
      // BudgetService.upsert which validates + persists.
      tier?: "llm" | "skill";
      skillSlug?: string | null;
      agentId?: string | null;
    },
  ) {
    const scope = this.getScope(req);
    // SECURITY (audit H16 — budget caps are operator-only (financial DoS otherwise)).
    requireOperator(scope);
    try {
      const cap = await this.budgetService.upsert(this.scopeTuple(scope), body);
      return { cap };
    } catch (err: any) {
      // Bug fix: previously returned `{ error, status: 400 }` as a 200 body,
      // so the webapp action saw `res.ok === true` and falsely reported the
      // cap saved. Throw a real BadRequest so the HTTP status reflects the
      // validation failure and the dashboard can surface the message.
      throw new BadRequestException({
        error: err?.message || "Upsert failed",
      });
    }
  }

  /** Delete a budget cap. */
  @Delete("budgets/:capId")
  async deleteBudget(@Req() req: Request, @Param("capId") capId: string) {
    const scope = this.getScope(req);
    // SECURITY (audit H16 — budget caps are operator-only).
    requireOperator(scope);
    const deleted = await this.budgetService.delete(this.scopeTuple(scope), capId);
    return { deleted };
  }

  /**
   * Admin override — bump a cap past 100% for N minutes. Captures the
   * operator's userId for the audit trail (surfaces in the dashboard).
   */
  @Post("budgets/:capId/override")
  async overrideBudget(
    @Req() req: Request,
    @Param("capId") capId: string,
    @Body() body: { minutes: number },
  ) {
    const scope = this.getScope(req);
    // SECURITY (audit H16 — budget override is operator-only).
    requireOperator(scope);
    const minutes = typeof body?.minutes === "number" ? body.minutes : 0;
    const cap = await this.budgetService.override(this.scopeTuple(scope), capId, {
      minutes,
      userId: scope.userId,
    });
    if (!cap) {
      // Bug fix: previously returned `{ status: 404 }` in a 200 body, which
      // the dashboard treated as success. Throw so the HTTP status is correct.
      throw new HttpException("Cap not found", 404);
    }
    return { cap };
  }

  /**
   * Admin-only: email delivery callback invoked by the budget-alert
   * trigger.dev task. Kept here (rather than a dedicated mail service)
   * so all OS deployments can wire their own SMTP backend via a shared
   * webhook integration. The endpoint itself is a no-op when no mailer
   * is configured — it logs and returns ok:true so the alert task
   * doesn't retry indefinitely.
   */
  @Post("monitoring/budget/email")
  async sendBudgetEmail(
    @Req() req: Request,
    @Body() body: { recipients: string[]; subject: string; body: string },
  ) {
    const expected = env.PLATOS_ADMIN_TOKEN;
    if (!expected) return { status: "skipped", reason: "PLATOS_ADMIN_TOKEN not set" };
    const provided = req.headers["x-platos-admin-token"];
    const isValid =
      typeof provided === "string" &&
      provided.length === expected.length &&
      (() => {
        try {
          return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
        } catch {
          return false;
        }
      })();
    if (!isValid) return { status: "forbidden" };
    // Best-effort: log; a real SMTP wire-up is per-deployment (OSS).
    console.log(
      `[budget-email] recipients=${body.recipients?.length ?? 0} subject="${body.subject}"`,
    );
    return { status: "ok", queued: body.recipients?.length ?? 0 };
  }

  // ═══════════════════════════════════════════════════════
  // Secrets readiness (for entity service-secret encryption only —
  // provider API keys are never stored by Platos per PLATOS_SPEC §4.4)
  // ═══════════════════════════════════════════════════════

  /** Check if the entity-secret encryption key is production-ready. */
  @Get("secrets/status")
  secretsStatus() {
    return {
      encryptionConfigured: this.secretsService.isProductionReady(),
      warning: this.secretsService.isProductionReady()
        ? null
        : "PLATOS_ENCRYPTION_KEY not set. Entity service secrets use an ephemeral key and will not survive restart.",
      // Theme H.4 — report message-at-rest crypto readiness alongside
      // the legacy entity-secret encryption status.
      messageCrypto: this.messageCrypto.status(),
    };
  }

  // ═══════════════════════════════════════════════════════
  // System Prompt Builder
  // ═══════════════════════════════════════════════════════

  /** Get default prompt blocks for a new agent */
  @Get("prompt/defaults")
  getDefaultBlocks(@Query("agentName") agentName?: string) {
    return { blocks: this.promptBuilder.getDefaultBlocks(agentName || "AI Assistant") };
  }

  /** Preview assembled prompt from blocks */
  @Post("prompt/preview")
  previewPrompt(@Body() body: { blocks: PromptBlock[]; variables?: Record<string, unknown> }) {
    return this.promptBuilder.preview(body.blocks, body.variables);
  }

  /**
   * Assemble prompt from blocks (returns the final string).
   *
   * RG.1.5 — switched to `assembleAsync` so `type: "retrieval"` blocks are
   * resolved against the `platos.platos_rag` skill at preview time.
   * Playground operators can verify their retrieval config renders
   * correctly. Fail-open — resolver errors leave the retrieval section
   * empty; the rest of the prompt still assembles.
   */
  @Post("prompt/assemble")
  async assemblePrompt(
    @Req() req: Request,
    @Body() body: {
      blocks: PromptBlock[];
      variables?: Record<string, unknown>;
      memoryContext?: string;
    },
  ) {
    const scope = this.getScope(req);
    const agentId = scope.agentId ?? null;
    const threadId = scope.sessionId ?? null;
    const skillRuntime = this.skillRuntime;
    const retrievalResolver = skillRuntime
      ? async (_toolCall: string, resolvedArgs: Record<string, unknown>) => {
          // RG.1.5 — dispatch to the built-in RAG retrieve tool.
          // Signature matches SkillRuntimeService.invokeTool. Scope is
          // request-scoped so retrieval respects (org, project, env).
          return await skillRuntime.invokeTool(
            {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              userId: scope.userId,
            },
            {
              skillSlug: "platos.platos_rag",
              toolName: "rag_retrieve",
              handler: "skill:platos.platos_rag:rag_retrieve",
              provider: null,
            },
            resolvedArgs,
            { agentId, threadId },
          );
        }
      : undefined;
    const assembled = await this.promptBuilder.assembleAsync(
      body.blocks,
      body.variables,
      body.memoryContext,
      retrievalResolver,
    );
    return {
      prompt: assembled,
      chars: assembled.length,
      estimatedTokens: Math.ceil(assembled.length / 4),
    };
  }

  // ═══════════════════════════════════════════════════════
  // Theme J — Ratings, criteria, evals, golden sets.
  // ═══════════════════════════════════════════════════════

  /**
   * Theme J.1 — upsert thumbs vote. Body: `{ messageId, rating: 1|-1, comment? }`.
   * Idempotent per (messageId, scope.userId). Rating must be ±1; zero is not a
   * valid vote — use DELETE to remove the rating.
   */
  @Post("messages/:messageId/rating")
  async rateMessage(
    @Req() req: Request,
    @Param("messageId") messageId: string,
    @Body() body: { rating: number; comment?: string | null },
  ) {
    const scope = this.getScope(req);
    if (body?.rating !== 1 && body?.rating !== -1) {
      return { error: "rating must be 1 or -1", status: 400 };
    }
    try {
      const row = await this.ratingService.upsert(scope, {
        messageId,
        rating: body.rating as 1 | -1,
        comment: body.comment ?? null,
      });
      return { rating: row };
    } catch (err: any) {
      return { error: err?.message || "Rating failed", status: 400 };
    }
  }

  /** Theme J.1 — remove the current user's rating on a message. */
  @Delete("messages/:messageId/rating")
  async unrateMessage(@Req() req: Request, @Param("messageId") messageId: string) {
    const scope = this.getScope(req);
    const removed = await this.ratingService.remove(scope, messageId);
    return { removed };
  }

  /** Theme J.1 — fetch the current user's vote + aggregate counts. */
  @Get("messages/:messageId/rating")
  async getMessageRating(
    @Req() req: Request,
    @Param("messageId") messageId: string,
  ) {
    const scope = this.getScope(req);
    return this.ratingService.getForMessage(scope, messageId);
  }

  /**
   * Theme J.2 — satisfaction aggregated per agent version. Used by the G.6
   * canary dashboard (score column) and the J.6 eval dashboard.
   */
  @Get("agents/:agentId/satisfaction")
  async getAgentSatisfaction(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Query("days") days?: string,
  ) {
    const scope = this.getScope(req);
    const parsedDays = days ? parseInt(days, 10) : undefined;
    return this.ratingService.satisfactionByVersion(
      this.scopeTuple(scope),
      agentId,
      { days: Number.isFinite(parsedDays as number) ? parsedDays : undefined },
    );
  }

  // ---- Theme J.3 — eval criteria CRUD ----

  @Post("eval-criteria")
  async createCriterion(@Req() req: Request, @Body() body: CreateCriterionDto) {
    const scope = this.getScope(req);
    try {
      const row = await this.criterionService.create(scope, body);
      return { criterion: row };
    } catch (err: any) {
      return { error: err?.message || "Create criterion failed", status: 400 };
    }
  }

  @Get("eval-criteria")
  async listCriteria(
    @Req() req: Request,
    @Query("agentId") agentId?: string,
    @Query("activeOnly") activeOnly?: string,
  ) {
    const scope = this.getScope(req);
    const criteria = await this.criterionService.list(this.scopeTuple(scope), {
      agentId: agentId ?? undefined,
      activeOnly: activeOnly === "true" || activeOnly === "1",
    });
    return { criteria, total: criteria.length };
  }

  @Get("eval-criteria/:criterionId")
  async getCriterion(
    @Req() req: Request,
    @Param("criterionId") criterionId: string,
  ) {
    const scope = this.getScope(req);
    const row = await this.criterionService.findById(this.scopeTuple(scope), criterionId);
    if (!row) return { error: "Criterion not found", status: 404 };
    return { criterion: row };
  }

  @Patch("eval-criteria/:criterionId")
  async updateCriterion(
    @Req() req: Request,
    @Param("criterionId") criterionId: string,
    @Body() body: UpdateCriterionDto,
  ) {
    const scope = this.getScope(req);
    try {
      const row = await this.criterionService.update(scope, criterionId, body);
      return { criterion: row };
    } catch (err: any) {
      return { error: err?.message || "Update criterion failed", status: 400 };
    }
  }

  @Delete("eval-criteria/:criterionId")
  async deleteCriterion(
    @Req() req: Request,
    @Param("criterionId") criterionId: string,
  ) {
    const scope = this.getScope(req);
    const deleted = await this.criterionService.remove(
      this.scopeTuple(scope),
      criterionId,
    );
    return { deleted };
  }

  // ---- Theme J.4 — judge-LLM pipeline kickoff ----

  /**
   * Run the judge LLM against a (thread, criterion) pair + write an eval row.
   * The judge model is the criterion's `judgeModel` (or the Haiku default).
   * Self-evaluation is blocked: if the judge model equals the agent's model
   * the request is rejected with status 409.
   */
  @Post("evals/run")
  async runEval(
    @Req() req: Request,
    @Body() body: {
      agentId: string;
      threadId: string;
      criterionId: string;
      messageId?: string;
      runId?: string;
      baselineVersionId?: string;
    },
  ) {
    const scope = this.getScope(req);
    try {
      const row = await this.evalService.runJudge(scope, body);
      return { eval: row };
    } catch (err: any) {
      if (err instanceof SelfEvaluationError) {
        return { error: err.message, status: 409 };
      }
      return { error: err?.message || "Eval run failed", status: 400 };
    }
  }

  // ---- Theme J.5 — PlatosAgentEval query API ----

  /**
   * List eval rows. Supports filters: agentId, agentVersionId, criterionId,
   * threadId, runId. Default window 30 days, max 200 rows per page.
   */
  @Get("evals")
  async listEvals(
    @Req() req: Request,
    @Query("agentId") agentId?: string,
    @Query("agentVersionId") agentVersionId?: string,
    @Query("criterionId") criterionId?: string,
    @Query("threadId") threadId?: string,
    @Query("runId") runId?: string,
    @Query("sinceDays") sinceDays?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const scope = this.getScope(req);
    const page = await this.evalService.list(this.scopeTuple(scope), {
      agentId,
      agentVersionId,
      criterionId,
      threadId,
      runId,
      sinceDays: sinceDays ? parseInt(sinceDays, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
    return { ...page, fetchedAt: new Date().toISOString() };
  }

  @Get("evals/:evalId")
  async getEval(@Req() req: Request, @Param("evalId") evalId: string) {
    const scope = this.getScope(req);
    const row = await this.evalService.getById(this.scopeTuple(scope), evalId);
    if (!row) return { error: "Eval not found", status: 404 };
    return { eval: row };
  }

  /**
   * Theme J.6 / J.7 — aggregate mean score per (criterion, version) for a
   * scoreboard view. `versionIds` narrows the payload to two versions for
   * A/B comparison.
   */
  @Get("agents/:agentId/evals/aggregate")
  async aggregateEvals(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Query("days") days?: string,
    @Query("versionIds") versionIdsCsv?: string,
  ) {
    const scope = this.getScope(req);
    const versionIds = versionIdsCsv
      ? versionIdsCsv
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined;
    const agg = await this.evalService.aggregate(this.scopeTuple(scope), agentId, {
      days: days ? parseInt(days, 10) : undefined,
      versionIds,
    });
    return agg;
  }

  // ---- Theme J.8 — golden-set regression runner ----

  @Post("golden-sets")
  async createGoldenSet(@Req() req: Request, @Body() body: CreateGoldenSetDto) {
    const scope = this.getScope(req);
    try {
      const row = await this.goldenSetService.create(scope, body);
      return { goldenSet: row };
    } catch (err: any) {
      return { error: err?.message || "Create golden set failed", status: 400 };
    }
  }

  @Get("golden-sets")
  async listGoldenSets(
    @Req() req: Request,
    @Query("agentId") agentId?: string,
  ) {
    const scope = this.getScope(req);
    const rows = await this.goldenSetService.list(this.scopeTuple(scope), {
      agentId: agentId ?? undefined,
    });
    return { goldenSets: rows, total: rows.length };
  }

  @Get("golden-sets/:goldenSetId")
  async getGoldenSet(
    @Req() req: Request,
    @Param("goldenSetId") goldenSetId: string,
  ) {
    const scope = this.getScope(req);
    const row = await this.goldenSetService.findById(
      this.scopeTuple(scope),
      goldenSetId,
    );
    if (!row) return { error: "Golden set not found", status: 404 };
    return { goldenSet: row };
  }

  @Patch("golden-sets/:goldenSetId")
  async updateGoldenSet(
    @Req() req: Request,
    @Param("goldenSetId") goldenSetId: string,
    @Body() body: UpdateGoldenSetDto,
  ) {
    const scope = this.getScope(req);
    try {
      const row = await this.goldenSetService.update(
        this.scopeTuple(scope),
        goldenSetId,
        body,
      );
      return { goldenSet: row };
    } catch (err: any) {
      return { error: err?.message || "Update golden set failed", status: 400 };
    }
  }

  @Delete("golden-sets/:goldenSetId")
  async deleteGoldenSet(
    @Req() req: Request,
    @Param("goldenSetId") goldenSetId: string,
  ) {
    const scope = this.getScope(req);
    const deleted = await this.goldenSetService.remove(
      this.scopeTuple(scope),
      goldenSetId,
    );
    return { deleted };
  }

  /**
   * Execute a golden set. Long-running: returns the full regression report
   * synchronously once every (thread × criterion) pair has been judged.
   */
  @Post("golden-sets/:goldenSetId/run")
  async runGoldenSet(
    @Req() req: Request,
    @Param("goldenSetId") goldenSetId: string,
    @Body() body: { baselineVersionId?: string | null } = {},
  ) {
    const scope = this.getScope(req);
    try {
      const result = await this.goldenSetService.run(scope, goldenSetId, {
        baselineVersionId: body?.baselineVersionId ?? null,
      });
      return result;
    } catch (err: any) {
      return { error: err?.message || "Golden set run failed", status: 400 };
    }
  }

  // ── Access Key management ─────────────────────────────────────────────────

  @Get("access-key")
  async getAccessKey(@Req() req: Request) {
    const scope = this.getScope(req);
    const record = await this.authService.getAccessKey({ organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId });
    return { key: record ?? null };
  }

  @Post("access-key/generate")
  async generateAccessKey(@Req() req: Request) {
    const scope = this.getScope(req);
    const result = await this.authService.generateAccessKey({ organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId });
    return result; // { rawKey, keyPrefix } — rawKey shown once
  }

  @Post("access-key/origins")
  async setAllowedOrigins(@Req() req: Request, @Body() body: { origins: string[] }) {
    const scope = this.getScope(req);
    const origins = (body.origins ?? []).map((o: string) => o.trim()).filter(Boolean);
    await this.authService.setAllowedOrigins({ organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId }, origins);
    return { ok: true, origins };
  }

  @Delete("access-key")
  async deleteAccessKey(@Req() req: Request) {
    const scope = this.getScope(req);
    await this.authService.deleteAccessKey({ organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId });
    return { ok: true };
  }

  // ── Postman Templates ─────────────────────────────────────────────────────

  @Get("postman-templates")
  async listPostmanTemplates(@Req() req: Request, @Query("agentId") agentId?: string) {
    const scope = this.getScope(req);
    const prisma = (this.costService as any).prisma;
    if (!prisma) return { templates: [] };
    const templates = await (prisma as any).platosPostmanTemplate.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        ...(agentId ? { agentId } : {}),
      },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
      select: { id: true, agentId: true, name: true, simulateUserId: true, sessionContext: true, isDefault: true, createdAt: true, updatedAt: true },
    });
    return { templates };
  }

  @Post("postman-templates")
  async createPostmanTemplate(
    @Req() req: Request,
    @Body() body: { agentId: string; name: string; simulateUserId: string; sessionContext?: unknown; isDefault?: boolean },
  ) {
    const scope = this.getScope(req);
    const prisma = (this.costService as any).prisma;
    if (!prisma) return { error: "unavailable" };
    if (body.isDefault) {
      await (prisma as any).platosPostmanTemplate.updateMany({
        where: { organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId, agentId: body.agentId },
        data: { isDefault: false },
      });
    }
    const template = await (prisma as any).platosPostmanTemplate.create({
      data: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        agentId: body.agentId,
        name: body.name,
        simulateUserId: body.simulateUserId,
        sessionContext: body.sessionContext ?? null,
        isDefault: body.isDefault ?? false,
        createdBy: scope.userId,
      },
    });
    return { template };
  }

  @Put("postman-templates/:id")
  async updatePostmanTemplate(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: { name?: string; simulateUserId?: string; sessionContext?: unknown; isDefault?: boolean },
  ) {
    const scope = this.getScope(req);
    const prisma = (this.costService as any).prisma;
    if (!prisma) return { error: "unavailable" };
    const existing = await (prisma as any).platosPostmanTemplate.findFirst({
      where: { id, organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId },
    });
    if (!existing) throw new NotFoundException("Template not found");
    if (body.isDefault) {
      await (prisma as any).platosPostmanTemplate.updateMany({
        where: { organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId, agentId: existing.agentId },
        data: { isDefault: false },
      });
    }
    const updated = await (prisma as any).platosPostmanTemplate.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.simulateUserId !== undefined ? { simulateUserId: body.simulateUserId } : {}),
        ...(body.sessionContext !== undefined ? { sessionContext: body.sessionContext } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
      },
    });
    return { template: updated };
  }

  @Delete("postman-templates/:id")
  async deletePostmanTemplate(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    const prisma = (this.costService as any).prisma;
    if (!prisma) return { error: "unavailable" };
    await (prisma as any).platosPostmanTemplate.deleteMany({
      where: { id, organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId },
    });
    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════
  // PRA-AC — Agent Cluster endpoints
  // ═══════════════════════════════════════════════════════

  @Post("clusters")
  async createCluster(@Req() req: Request, @Body() body: { name: string; slug: string; description?: string; primaryAgentId?: string; agentIds?: string[] }) {
    const scope = this.getScope(req);
    try {
      const cluster = await this.clusterService.create(scope, body);
      return { cluster };
    } catch (err: any) {
      return { error: err?.message || "create failed", status: 400 };
    }
  }

  @Get("clusters")
  async listClusters(@Req() req: Request) {
    const scope = this.getScope(req);
    return { clusters: await this.clusterService.list(scope) };
  }

  @Get("clusters/:clusterId")
  async getCluster(@Req() req: Request, @Param("clusterId") clusterId: string) {
    const scope = this.getScope(req);
    const cluster = await this.clusterService.get(clusterId, scope);
    if (!cluster) return { error: "not found", status: 404 };
    return { cluster };
  }

  @Patch("clusters/:clusterId")
  async updateCluster(@Req() req: Request, @Param("clusterId") clusterId: string, @Body() body: { name?: string; slug?: string; description?: string; primaryAgentId?: string }) {
    const scope = this.getScope(req);
    try {
      const cluster = await this.clusterService.update(clusterId, scope, body);
      return { cluster };
    } catch (err: any) {
      return { error: err?.message || "update failed", status: 400 };
    }
  }

  @Delete("clusters/:clusterId")
  async deleteCluster(@Req() req: Request, @Param("clusterId") clusterId: string) {
    const scope = this.getScope(req);
    try {
      await this.clusterService.delete(clusterId, scope);
      return { ok: true };
    } catch (err: any) {
      return { error: err?.message || "delete failed", status: 400 };
    }
  }

  @Post("clusters/:clusterId/agents")
  async addAgentToCluster(@Req() req: Request, @Param("clusterId") clusterId: string, @Body() body: { agentId: string; role?: string }) {
    const scope = this.getScope(req);
    try {
      await this.clusterService.addAgent(clusterId, body.agentId, scope, body.role);
      return { ok: true };
    } catch (err: any) {
      return { error: err?.message || "add failed", status: 400 };
    }
  }

  @Delete("clusters/:clusterId/agents/:agentId")
  async removeAgentFromCluster(@Req() req: Request, @Param("clusterId") clusterId: string, @Param("agentId") agentId: string) {
    const scope = this.getScope(req);
    try {
      await this.clusterService.removeAgent(clusterId, agentId, scope);
      return { ok: true };
    } catch (err: any) {
      return { error: err?.message || "remove failed", status: 400 };
    }
  }
}
