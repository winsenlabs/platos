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
  Logger,
} from "@nestjs/common";
import { type Request, type Response } from "express";
import * as crypto from "node:crypto";
import {
  CONVERSATION_REVISION_NOT_SUPPORTED,
  ConversationRevisionNotSupportedError,
  ConversationService,
  ThreadForkLimitError,
  ThreadMessageNotFoundError,
  ThreadNotFoundError,
} from "../memory/conversation.service";
import { AgentTaskService } from "./agent-task.service";
import { TurnDispatchService } from "./turn-dispatch.service";
import { withHeartbeat } from "../shared/async-heartbeat";
import { AgentService } from "./agent.service";
import { ToolRegistryService } from "../tool-gateway/tool-registry.service";
import { ToolSyncWsService } from "../tool-gateway/tool-sync-ws.service";
import { AuthService } from "../auth/auth.service";
import { StreamingService } from "../streaming/streaming.service";
import { CostService } from "../monitoring/cost.service";
import { assertCostCatalogIngestion } from "../monitoring/cost-catalog-ingestion";
import { preflightModelPricing } from "../monitoring/model-pricing-preflight";
import { SpansService } from "../monitoring/spans.service";
import { ObservabilityService } from "../observability/observability.service";
import { failedDrainSummary } from "../observability/observability-outbox";
import { TraceService } from "../monitoring/trace.service";
import { UtilizationService } from "../monitoring/utilization.service";
import { ToolAuditService } from "../monitoring/tool-audit.service";
import { MonitoringApprovalsService } from "../monitoring/approvals.service";
import { ToolExecutorService } from "../tool-gateway/tool-executor.service";
// MCP-connected-entity (design Commit 5) — outbound tools/list discovery for
// connectionKind=="mcp" entities. Exported by ToolGatewayModule (imported by
// AgentRuntimeModule). Optional so hand-built test harnesses that omit it still
// construct the controller.
import { EntityMcpDiscoveryService } from "../tool-gateway/mcp-transport/entity-mcp-discovery.service";
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
import {
  validateIdentityProviders,
  validateMcpIdentityMode,
} from "../mcp-platform/mcp-management.validation";
import type { SessionScope } from "./session-scope";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import { BudgetService, type BudgetPeriod, type BudgetScopeType } from "../monitoring/budget.service";
import type { BudgetAlertPayload } from "../monitoring/budget-alert.types";
import { SafetyEventService } from "../monitoring/safety-event.service";
import { GovernanceService } from "../monitoring/governance.service";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { approvalRedisKey } from "../monitoring/approval-keys";
import { RatingMutationForbiddenError, RatingService, RatingTargetNotFoundError } from "../evals/rating.service";
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
import { Prisma } from "@platos/tenancy-database";
import {
  type ControlDatabaseClient,
  environmentScopeWhere,
} from "../shared/database.provider";
import {
  pageMetadata,
  isUuid,
  parseBooleanFilter,
  parseEnumFilter,
  parsePageRequest,
  parsePositiveIntegerFilter,
} from "../shared/pagination";

const EXTERNAL_END_USER_IDENTITY = {
  issuer: "platos:external",
  channel: "external",
  disabledAt: null,
} as const;

function currentEnvironmentEndUserPresence(environmentId: string) {
  return {
    OR: [
      { threads: { some: { environmentId } } },
      { memories: { some: { environmentId } } },
      { messageAttachments: { some: { environmentId } } },
      { toolCallAudits: { some: { environmentId } } },
      { safetyEvents: { some: { environmentId } } },
    ],
  };
}

/**
 * Agent REST API — every endpoint calls real services.
 * All queries scoped by (organizationId, projectId, environmentId, userId) from ScopeGuard.
 */
@Controller("api/v1/agent")
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly agentTaskService: AgentTaskService,
    // The durable-vs-direct chokepoint. The turn endpoints route through this
    // (collectTurn for non-streaming, streamTurn for SSE) instead of calling
    // execute*Turn directly, so a durable agent hitting the REST/SSE surface
    // dispatches to Trigger like any other entry path — the decision is no
    // longer forgotten here.
    private readonly dispatch: TurnDispatchService,
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
    // WIN-133 — turn-shaped analytical projection: outbox drain + sink health.
    private readonly observability: ObservabilityService,
    // RG.1.5 — optional SkillRuntimeService (must come last — optional params follow required)
    @Optional() private readonly skillRuntime?: SkillRuntimeService,
    // MCP-connected-entity (design Commit 5) — kicks discovery on mcp-kind
    // register/refresh. Optional for the same test-harness reason as above.
    @Optional() private readonly entityMcpDiscovery?: EntityMcpDiscoveryService,
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

  private get prisma(): ControlDatabaseClient {
    return (this.agentService as unknown as { prisma: ControlDatabaseClient }).prisma;
  }

  /**
   * Resolve the effective agentId for a thread-scoped turn so the dispatch
   * chokepoint reads executionMode for the RIGHT agent. The SDK's
   * `threads.send` / `threads.stream` routinely omit agentId (the thread
   * already stores it), so — mirroring executeStreamingTurn's own resolution —
   * fall back to the thread row's agentId when none is passed. Resolved through
   * ConversationService.getThread, which is scope + ownership gated (IDOR-safe);
   * a thread the caller can't see resolves to the "default" fallback (a durable
   * turn's own getOrCreateThread then re-gates on dispatch). Last resort:
   * "default" — identical to the runtime's own agentId fallback.
   */
  private async resolveThreadAgentId(
    threadId: string | undefined,
    explicit: string | undefined,
    scope: RequestScope,
  ): Promise<string> {
    if (explicit) return explicit;
    if (threadId) {
      try {
        const thread = await this.conversationService.getThread(threadId, scope);
        if ((thread as { agentId?: string } | null)?.agentId) {
          return (thread as { agentId: string }).agentId;
        }
      } catch {
        /* fall through to default */
      }
    }
    return "default";
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
    // LATENCY (audit F4) — run both ownership checks concurrently instead of
    // serially. Both are still REQUIRED (fail-closed): the guards below only
    // reject on an absent anchor's failed lookup, so an omitted id short-
    // circuits its own guard exactly as before. One round-trip saved per
    // internal callback.
    const [agent, thread] = await Promise.all([
      body.agentId
        ? this.agentCrud.findById(body.agentId, body.scope as any).catch(() => null)
        : Promise.resolve(null),
      body.threadId
        ? this.conversationService
            .getThread(body.threadId, body.scope as any, { allUsers: true })
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    if (body.agentId && !agent) return false;
    if (body.threadId && !thread) return false;
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
    // Preserve the not-found contract at the HTTP boundary. The clean
    // ConversationService also checks the AgentBinding, but its generic error
    // would otherwise be rendered as a 500 for a cross-scope agent id.
    const agent = await this.agentCrud.findById(agentId, scope);
    if (!agent) {
      throw new NotFoundException({ error: "Agent not found", agentId });
    }
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
    @Query("page") page?: string,
  ) {
    const scope = this.getScope(req);
    const request = parsePageRequest({ page, limit, offset }, { defaultPageSize: 25, maxPageSize: 100 });
    const pinnedFlag = pinned === "true" || pinned === "1" ? true : undefined;
    let archivedFlag: boolean | "only" | undefined;
    if (archived === "only") archivedFlag = "only";
    else if (archived === "true" || archived === "1") archivedFlag = true;
    else archivedFlag = undefined; // default — hide archived
    const result = await this.conversationService.listThreads(scope, {
      agentId,
      status,
      limit: request.pageSize,
      offset: request.offset,
      tag,
      pinned: pinnedFlag,
      archived: archivedFlag,
      // Operators see the Environment-wide ledger by default and may opt back
      // into their own EndUser projection with allUsers=false. End users can
      // never bypass canonical ownership.
      allUsers: scope.principal === "operator" && allUsers !== "false" && allUsers !== "0",
    });
    const pagination = pageMetadata(result.total, request);
    return {
      ...result,
      items: result.threads,
      limit: request.pageSize,
      offset: request.offset,
      hasMore: pagination.hasNext,
      pagination,
      filters: { agentId: agentId ?? null, status: status ?? null, tag: tag ?? null, pinned: pinnedFlag ?? null, archived: archivedFlag ?? null },
    };
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
      // SECURITY (audit authz-2026-07-22 F1/F6) — operator-only cross-user view;
      // non-operators fall back to their own-thread ownership check.
      allUsers: scope.principal === "operator" && allUsers !== "false" && allUsers !== "0",
    });
    if (!thread) throw new NotFoundException("Thread not found");
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
      throw new BadRequestException("tags must be an array of strings");
    }
    try {
      const thread = await this.conversationService.setThreadTags(
        threadId,
        scope,
        body.tags,
      );
      return thread;
    } catch (err: any) {
      throw new BadRequestException(err?.message || "Failed to set tags");
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
      throw new BadRequestException(err?.message || "Failed to toggle pin");
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
      throw new BadRequestException(err?.message || "Failed to archive thread");
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
      throw new BadRequestException(err?.message || "Failed to unarchive thread");
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
    // Route through the dispatch chokepoint: a durable agent here now drives a
    // Trigger SESSION (the ONE durable mechanism) and returns the reply
    // accumulated off its durable .out; a direct agent runs in-process exactly
    // as before (collectTurn's direct arm returns the same {text, threadId,
    // events, costCents} shape as executeNonStreamingTurn, plus messageId).
    const agentId = await this.resolveThreadAgentId(threadId, body.agentId, scope);
    const result = await this.dispatch.collectTurn(agentId, {
      scope,
      message: body.message,
      threadId,
      attachmentIds: body.attachmentIds,
    });
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
    @Query("page") page?: string,
  ) {
    const scope = this.getScope(req);
    const request = parsePageRequest({ page, limit, offset }, { defaultPageSize: 25, maxPageSize: 100 });
    try {
      const result = await this.conversationService.getMessages(threadId, scope, {
        limit: request.pageSize,
        offset: request.offset,
        // Operators see all in-scope EndUsers by default. Non-operators always
        // retain the canonical EndUser ownership predicate.
        allUsers: scope.principal === "operator" && allUsers !== "false" && allUsers !== "0",
      });
      const pagination = pageMetadata(result.total, request);
      return {
        ...result,
        items: result.messages,
        limit: request.pageSize,
        offset: request.offset,
        hasMore: pagination.hasNext,
        pagination,
        filters: {},
      };
    } catch (error) {
      if (error instanceof ThreadNotFoundError) {
        throw new NotFoundException({ code: error.code, message: error.message });
      }
      throw error;
    }
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
   * The new thread references canonical history through `upToMessageId`
   * (inclusive) and inherits the parent's scope. Turn/Step/ToolCall ledger rows
   * are never cloned or billed again.
   */
  @Post("threads/:threadId/fork")
  async forkThread(
    @Req() req: Request,
    @Param("threadId") threadId: string,
    @Body() body: { upToMessageId: string; title?: string },
  ) {
    const scope = this.getScope(req);
    if (!body?.upToMessageId) {
      throw new BadRequestException("upToMessageId required");
    }
    try {
      const fork = await this.conversationService.forkThread(threadId, scope, {
        upToMessageId: body.upToMessageId,
        title: body.title,
        allUsers: scope.principal === "operator",
      });
      return fork;
    } catch (err: any) {
      if (err instanceof ThreadNotFoundError || err instanceof ThreadMessageNotFoundError) {
        throw new NotFoundException({ code: err.code, message: err.message });
      }
      if (err instanceof ThreadForkLimitError) {
        throw new HttpException({ code: err.code, message: err.message }, HttpStatus.CONFLICT);
      }
      throw new ServiceUnavailableException({ code: "THREAD_FORK_UNAVAILABLE", message: "Thread fork is unavailable" });
    }
  }

  /**
   * Edit a user message + rerun the agent from there.
   *
   * Disabled on the clean normalized schema until distinct revision and
   * branch-head relations can preserve the original Turn evidence.
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
      throw new BadRequestException("content required (non-empty string)");
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
      if (err instanceof ConversationRevisionNotSupportedError) {
        throw new HttpException(CONVERSATION_REVISION_NOT_SUPPORTED, HttpStatus.CONFLICT);
      }
      throw new BadRequestException(err?.message || "Edit failed");
    }
  }

  /**
   * Retry an assistant turn with (optionally) different model or temperature.
   *
   * Disabled on the clean normalized schema until retries can create a new
   * branch without overwriting the original Turn, Step, or ToolCall evidence.
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
      if (err instanceof ConversationRevisionNotSupportedError) {
        throw new HttpException(CONVERSATION_REVISION_NOT_SUPPORTED, HttpStatus.CONFLICT);
      }
      throw new BadRequestException(err?.message || "Retry failed");
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
    @Query("offset") offset?: string,
    @Query("page") page?: string,
  ) {
    const scope = this.getScope(req);
    const request = parsePageRequest({ page, limit, offset }, { defaultPageSize: 25, maxPageSize: 100 });
    try {
      const result = await this.conversationService.listThreadArtifactsPage(
        threadId,
        scope,
        { limit: request.pageSize, offset: request.offset, allUsers: scope.principal === "operator" },
      );
      const pagination = pageMetadata(result.total, request);
      return {
        ...result,
        items: result.artifacts,
        limit: request.pageSize,
        offset: request.offset,
        hasMore: pagination.hasNext,
        pagination,
      };
    } catch (err: any) {
      if (err instanceof ThreadNotFoundError) {
        throw new NotFoundException({ code: err.code, message: err.message });
      }
      throw new ServiceUnavailableException({ code: "ARTIFACTS_UNAVAILABLE", message: "Thread artifacts are unavailable" });
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
    // Route through the dispatch chokepoint. For a DIRECT agent, streamTurn
    // yields EXACTLY what executeStreamingTurn yields (byte-for-byte token
    // stream — zero behavior change). For a DURABLE agent it drives a Trigger
    // SESSION and relays its durable .out (real token deltas + message_persisted
    // + done) over SSE, fail-open to the in-process stream when the session is
    // unavailable pre-commit.
    const agentId = await this.resolveThreadAgentId(threadId, body.agentId, scope);
    const rawEvents = this.dispatch.streamTurn(agentId, {
      scope,
      message: body.message,
      threadId,
      dynamicBlocks: body.dynamicBlocks,
      attachmentIds: body.attachmentIds,
      systemPromptOverride: body.systemPromptOverride ?? null,
      outputSchema: body.outputSchema,
      modelLabel: body.modelLabel,
      abortSignal: ac.signal,
      idempotencyKey:
        (req.headers["idempotency-key"] as string | undefined) ||
        (req.headers["Idempotency-Key"] as string | undefined),
    });
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
    // Idempotency boundary: an approval that already has a persisted outcome
    // must never wake the runtime waitpoint a second time. Return the canonical
    // decision instead of replaying Redis side effects.
    if ((found as any).status !== "pending") {
      return {
        resolved: true,
        approvalId,
        approved: (found as any).status === "approved",
        status: (found as any).status,
        persisted: true,
        ...((found as any).editedArgs != null ? { editedArgsApplied: true } : {}),
      };
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
      // The waiting executor consumes these exact operator-approved args.
      // Persisted audit metadata keeps the same value for later inspection.
      ...(validatedEditedArgs ? { editedArgs: validatedEditedArgs } : {}),
    });
    // Claim the pending row before waking Redis. updateMany(status=PENDING)
    // makes concurrent resolves exactly-once. A loser returns the persisted
    // outcome below and cannot enqueue a second dispatch decision.
    const changed = await this.approvalsService.resolve({
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
    if (changed === false) {
      const persisted = await this.approvalsService.getById(scopeTuple, approvalId);
      if (persisted && persisted.status !== "pending") {
        return {
          resolved: true,
          approvalId,
          approved: persisted.status === "approved",
          status: persisted.status,
          persisted: true,
          ...(persisted.editedArgs != null ? { editedArgsApplied: true } : {}),
        };
      }
      throw new ServiceUnavailableException({
        error: "Approval decision could not be persisted",
        approvalId,
      });
    }
    const redisKey = approvalRedisKey(scopeTuple, approvalId);
    await (this.agentService as any).redis.rpush(redisKey, payload);
    await (this.agentService as any).redis.expire(redisKey, 60); // cleanup
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
    // SECURITY (audit authz-2026-07-22 F2) — agent creation is a mutating
    // control-plane action; operator-only (audit fix: "every mutating handler
    // in the :949-1385 block"). Runtime chat never creates agents.
    requireOperator(scope);
    return this.agentCrud.create(scope, body);
  }

  @Get("agents")
  async listAgents(
    @Req() req: Request,
    @Query("page") pageRaw?: string,
    @Query("limit") limitRaw?: string,
    @Query("offset") offsetRaw?: string,
    @Query("search") searchRaw?: string,
    @Query("status") statusRaw?: string,
  ) {
    const scope = this.getScope(req);
    // SECURITY (audit authz-2026-07-22 F2) — `agentCrud.list` returns the FULL
    // AgentRecord (systemPrompt, promptBlocks, toolsBlockConfig) for every agent
    // in scope — the exact data the gated `getAgent` protects. Without this gate
    // an end-user/guest reads every agent's config via the list sibling, defeating
    // the getAgent gate. Operator/dashboard-only.
    requireOperator(scope);
    const request = parsePageRequest({ page: pageRaw, limit: limitRaw, offset: offsetRaw, search: searchRaw });
    const status = parseEnumFilter(statusRaw, "status", ["active", "paused"] as const);
    const result = await this.agentCrud.listPage(scope, {
      limit: request.pageSize,
      offset: request.offset,
      search: request.search,
      status,
    });
    const pagination = pageMetadata(result.total, request);
    return {
      agents: result.agents,
      items: result.agents,
      total: result.total,
      limit: request.pageSize,
      offset: request.offset,
      hasMore: pagination.hasNext,
      pagination,
      filters: { search: request.search, status },
    };
  }

  @Get("agents/:agentId")
  async getAgent(@Req() req: Request, @Param("agentId") agentId: string) {
    const scope = this.getScope(req);
    // SECURITY (audit authz-2026-07-22 F2) — full agent config (systemPrompt,
    // tools, model routes) is an operator/dashboard read. The agent-pin only
    // authenticates WHICH agent a runtime token may drive, not config access.
    requireOperator(scope);
    const agent = await this.agentCrud.findById(agentId, scope);
    if (!agent) throw new NotFoundException({ error: "Agent not found", agentId });
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
    // Route through the dispatch chokepoint (agentId is the path param — always
    // explicit). Direct → identical in-process result shape; durable → driven
    // on a Trigger SESSION, reply accumulated off its durable .out. Same option
    // forwarding as before (outputSchema is intentionally still not forwarded
    // here, matching prior behavior — zero behavior change for direct agents).
    const result = await this.dispatch.collectTurn(agentId, {
      scope,
      message: body.message,
      threadId: body.threadId,
      attachmentIds: body.attachmentIds,
      ...(body.systemPromptOverride !== undefined ? { systemPromptOverride: body.systemPromptOverride } : {}),
      modelLabel: body.modelLabel,
      ...(agentConfigOverride ? { agentConfigOverride } : {}),
    });
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
    // Route through the dispatch chokepoint (agentId is the path param). Direct
    // → identical in-process token stream; durable → driven on a Trigger SESSION
    // and its durable .out relayed over SSE, fail-open to in-process when the
    // session is unavailable pre-commit.
    const rawEvents = this.dispatch.streamTurn(agentId, {
      scope,
      message,
      threadId,
      attachmentIds,
      abortSignal: ac.signal,
      ...(agentConfigOverride ? { agentConfigOverride } : {}),
    });
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
    @Query("page") pageRaw?: string,
    @Query("limit") limitRaw?: string,
    @Query("offset") offsetRaw?: string,
    @Query("search") searchRaw?: string,
  ) {
    const scope = this.getScope(req);
    // SECURITY (audit authz-2026-07-22 F2) — per-agent tool matrix + param
    // mappings are operator/dashboard config-reads ("every config-read handler
    // in the :949-1385 block"). The scope-gate below is cross-SCOPE protection
    // only; requireOperator is the cross-USER (end-user↔operator) gate.
    requireOperator(scope);
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
    // Load every Environment mapping, including policies currently denied for
    // this Agent, so the same AgentToolPolicy row can be enabled again. The
    // Agent-specific enabled state is projected from allowedAgentIds below;
    // EnvironmentEntityTool.enabled remains a separate dispatch prerequisite.
    const request = parsePageRequest({ page: pageRaw, limit: limitRaw, offset: offsetRaw, search: searchRaw });
    const tools = this.toolRegistry
      .getScopedTools(this.scopeTuple(scope), {
        enabledOnly: false,
      })
      .filter((tool) => !request.search || [tool.toolName, tool.description, tool.sourceEntityId, tool.category]
        .some((value) => String(value ?? "").toLowerCase().includes(request.search!.toLowerCase())))
      .sort((left, right) => left.toolName.localeCompare(right.toolName)
        || String(left.sourceEntityId ?? "").localeCompare(String(right.sourceEntityId ?? ""))
        || left.toolId.localeCompare(right.toolId));
    const total = tools.length;
    const pageTools = tools.slice(request.offset, request.offset + request.pageSize);
    const healthRows: Array<{
      toolId: string;
      entityExternalId: string | null;
      environmentId: string;
      lastStatus: string | null;
    }> = pageTools.length
      ? await this.prisma.toolHealth.findMany({
          where: {
            environmentId: scope.environmentId,
            OR: pageTools.map((tool) => ({ toolId: tool.toolId, entityExternalId: tool.sourceEntityId })),
          },
        })
      : [];
    const healthByKey = new Map<string, string | null>();
    for (const h of healthRows) {
      healthByKey.set(`${h.toolId}:${h.entityExternalId ?? ""}`, h.lastStatus);
    }

    const rows = pageTools.map((t) => {
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
      const enabled = t.allowedAgentIds.includes(agentId);
      return {
        agentId,
        agentVersionId: (agent as { currentVersionId?: string | null }).currentVersionId ?? null,
        toolId: t.toolId,
        toolName: t.toolName,
        sourceEntity: t.sourceEntityId,
        enabled,
        environmentEnabled: t.enabled,
        dispatchable: enabled && t.enabled && t.dispatchable,
        health: healthByKey.get(`${t.toolId}:${t.sourceEntityId}`) ?? "unknown",
        params: resolved.params,
        mapped,
        total: resolved.params.length,
        warnings: resolved.warnings,
      };
    });
    return {
      tools: rows,
      declaredKeys: mapping?.declaredKeys ?? [],
      toolExposure:
        (agent as { toolsBlockConfig?: { toolExposure?: unknown } }).toolsBlockConfig?.toolExposure === "direct"
          ? "direct"
          : "meta",
      agentId,
      total,
      limit: request.pageSize,
      offset: request.offset,
      hasMore: request.offset + rows.length < total,
      pagination: pageMetadata(total, request),
      filters: { search: request.search },
      fetchedAt: new Date().toISOString(),
    };
  }

  /** Replace one Agent-owned Tool policy without mutating Environment exposure. */
  @Patch("agents/:agentId/tool-mappings/:toolId")
  async setAgentToolEnabled(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Param("toolId") toolId: string,
    @Body() body: { enabled?: unknown },
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);
    if (!isUuid(agentId) || !isUuid(toolId) || typeof body?.enabled !== "boolean") {
      throw new BadRequestException({
        code: "invalid_agent_tool_mapping_request",
        error: "Agent ID, Tool ID, and boolean enabled are required",
      });
    }
    const updated = await this.agentCrud.setToolEnabled(
      agentId,
      toolId,
      scope,
      body.enabled,
    );
    if (!updated) {
      throw new NotFoundException({
        code: "agent_tool_mapping_not_found",
        error: "Agent tool mapping not found in this scope",
      });
    }
    await this.toolRegistry.refreshEnvironmentPolicies(this.scopeTuple(scope));
    return { ok: true, ...updated };
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
    // SECURITY (audit authz-2026-07-22 F2) — per-agent category config
    // (enabledCategories + user-authored descriptions) is an operator/dashboard
    // config-read ("every config-read handler in the :949-1385 block").
    requireOperator(scope);
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
    // SECURITY (audit authz-2026-07-22 F2) — agent config mutation is operator-only.
    requireOperator(scope);
    return this.agentCrud.update(agentId, scope, body);
  }

  @Delete("agents/:agentId")
  async deleteAgent(@Req() req: Request, @Param("agentId") agentId: string) {
    const scope = this.getScope(req);
    // SECURITY (audit authz-2026-07-22 F2) — agent deletion is operator-only.
    requireOperator(scope);
    const deleted = await this.agentCrud.delete(agentId, scope);
    return { deleted };
  }

  // ═══════════════════════════════════════════════════════
  // Theme G — Agent lifecycle (versions, rollback, canary, flags)
  // ═══════════════════════════════════════════════════════

  /**
   * List saved versions of an agent, newest first.
   *
   * PPR-44 / WIN-236 — paginated. Existing `cursor`/`nextCursor` callers stay
   * compatible; offset callers additionally receive a truthful scoped total
   * and range metadata. `take` remains the page-size parameter.
   */
  @Get("agents/:agentId/versions")
  async listAgentVersions(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Query("cursor") cursor?: string,
    @Query("take") take?: string,
    @Query("offset") offsetRaw?: string,
  ) {
    const scope = this.getScope(req);
    // SECURITY (audit authz-2026-07-22 F2) — version history exposes full config; operator-only.
    requireOperator(scope);
    const request = parsePageRequest({ limit: take, offset: offsetRaw }, { defaultPageSize: 50 });
    try {
      const result = await this.agentCrud.listVersions(agentId, scope, {
        cursor: cursor || null,
        take: request.pageSize,
        offset: request.offset,
      });
      const pagination = cursor
        ? undefined
        : pageMetadata(result.total, { pageSize: result.limit, offset: result.offset });
      return {
        versions: result.versions,
        items: result.versions,
        nextCursor: result.nextCursor,
        pageSize: result.versions.length,
        total: result.total,
        limit: result.limit,
        offset: cursor ? null : result.offset,
        hasMore: cursor ? Boolean(result.nextCursor) : pagination!.hasNext,
        pagination,
        filters: {},
      };
    } catch (err: any) {
      throw new NotFoundException(err?.message || "List versions failed");
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
    // SECURITY (audit authz-2026-07-22 F2) — version config read; operator-only.
    requireOperator(scope);
    const version = await this.agentCrud.getVersion(agentId, versionId, scope);
    if (!version) throw new NotFoundException("Version not found");
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
    // SECURITY (audit authz-2026-07-22 F2) — version rollback is operator-only.
    requireOperator(scope);
    try {
      const agent = await this.agentCrud.rollbackToVersion(agentId, versionId, scope);
      await this.toolRegistry.refreshEnvironmentPolicies(this.scopeTuple(scope));
      return { agent };
    } catch (err: any) {
      throw new BadRequestException(err?.message || "Rollback failed");
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
    // SECURITY (audit authz-2026-07-22 F2) — canary routing config is operator-only.
    requireOperator(scope);
    try {
      const agent = await this.agentCrud.setCanary(agentId, scope, {
        canaryVersionId: body.canaryVersionId ?? null,
        canaryPercent: body.canaryPercent ?? 0,
      });
      return { agent };
    } catch (err: any) {
      throw new BadRequestException(err?.message || "Canary update failed");
    }
  }

  /**
   * Theme G.6 — canary metrics side-by-side.
   * Returns cost / latency / error rate grouped by persisted Turn.agentVersionId,
   * with the active/canary cohort read from the scoped AgentBinding.
   * Default window: last 24h. Max: 720h (30d).
   */
  @Get("agents/:agentId/canary/metrics")
  async getAgentCanaryMetrics(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Query("hours") hoursRaw?: string,
  ) {
    const scope = this.getScope(req);
    // SECURITY (audit authz-2026-07-22 F2) — canary metrics aggregate is operator-only
    // (mirrors the monitoring-aggregate norm in the same controller).
    requireOperator(scope);
    const hours = hoursRaw ? parseInt(hoursRaw, 10) : undefined;
    try {
      return await this.agentCrud.getCanaryMetrics(agentId, scope, {
        hours: isNaN(hours as number) ? undefined : hours,
      });
    } catch (err: any) {
      throw new BadRequestException(err?.message || "Canary metrics failed");
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
    // SECURITY (audit authz-2026-07-22 F2) — feature-flag mutation is operator-only.
    requireOperator(scope);
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
        throw new BadRequestException({
          error: err.message,
          code: err.code,
          unknownKeys: err.unknownKeys,
        });
      }
      throw new BadRequestException(err?.message || "Feature flags update failed");
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
    // SECURITY (audit authz-2026-07-22 F2) — canary promotion is operator-only.
    requireOperator(scope);
    try {
      const agent = await this.agentCrud.promoteCanary(agentId, scope);
      return { agent };
    } catch (err: any) {
      throw new BadRequestException(err?.message || "Canary promotion failed");
    }
  }

  // ═══════════════════════════════════════════════════════
  // Providers — env-var linking (Theme B.7)
  // ═══════════════════════════════════════════════════════

  /** Models the model picker should show — providers that are enabled + envReady. */
  @Get("providers/models")
  async availableModels(@Req() req: Request) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const authorization = await this.authService.authorizeEnvironmentOperatorScope(scope, "metadata");
    return this.providerRegistry.availableModels(authorization);
  }

  /** Run a live health probe across every manifest provider. */
  @Get("providers/health")
  async checkProviderHealth(@Req() req: Request) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const authorization = await this.authService.authorizeEnvironmentOperatorScope(scope, "metadata");
    return this.providerHealth.testAllProviders(authorization);
  }

  /** Live health probe for a single provider. */
  @Get("providers/:provider/health")
  async testProvider(@Req() req: Request, @Param("provider") provider: string) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const authorization = await this.authService.authorizeEnvironmentOperatorScope(scope, "metadata");
    return this.providerHealth.testProvider(authorization, provider);
  }

  /** Enable a provider in the current scope (upsert). */
  @Post("providers/:provider/link")
  async linkProvider(@Req() req: Request, @Param("provider") provider: string) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const authorization = await this.authService.authorizeEnvironmentOperatorScope(scope, "secret:mutate");
    return this.providerRegistry.link(authorization, provider);
  }

  /** Remove the enabled row (reverts to default envReady behavior). */
  @Delete("providers/:provider/link")
  async unlinkProvider(@Req() req: Request, @Param("provider") provider: string) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const authorization = await this.authService.authorizeEnvironmentOperatorScope(scope, "secret:mutate");
    await this.providerRegistry.unlink(authorization, provider);
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
    requireOperator(scope);
    const authorization = await this.authService.authorizeEnvironmentOperatorScope(scope, "secret:mutate");
    return this.providerRegistry.setEnabled(authorization, provider, body.enabled);
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
  async toolMatrix(
    @Req() req: Request,
    @Query("page") pageRaw?: string,
    @Query("limit") limitRaw?: string,
    @Query("offset") offsetRaw?: string,
    @Query("search") searchRaw?: string,
    @Query("category") category?: string,
    @Query("status") status?: string,
    @Query("entityId") entityId?: string,
  ) {
    const scope = this.getScope(req);
    const request = parsePageRequest({ page: pageRaw, limit: limitRaw, offset: offsetRaw, search: searchRaw });
    const allTools = this.toolRegistry.getScopedTools(this.scopeTuple(scope), {
      enabledOnly: false,
    });
    const normalizedStatus = parseEnumFilter(status?.trim().toLowerCase(), "status", ["dispatchable", "disabled", "unavailable"] as const);
    const matchingTools = allTools
      .filter((tool) => !entityId || tool.sourceEntityId === entityId || tool.entityPk === entityId)
      .filter((tool) => !request.search || [tool.toolName, tool.description, tool.sourceEntityId, tool.category].some((value) => String(value ?? "").toLowerCase().includes(request.search!.toLowerCase())))
      .filter((tool) => !category || (tool.category ?? "uncategorized") === category)
      .sort((left, right) => left.toolName.localeCompare(right.toolName) || String(left.sourceEntityId ?? "").localeCompare(String(right.sourceEntityId ?? "")) || left.toolId.localeCompare(right.toolId));
    const aggregates = {
      dispatchable: matchingTools.filter((tool) => tool.dispatchable).length,
      unavailable: matchingTools.filter((tool) => !tool.dispatchable).length,
      disabled: matchingTools.filter((tool) => !tool.enabled).length,
    };
    const tools = matchingTools.filter((tool) => !normalizedStatus || (normalizedStatus === "dispatchable" ? tool.dispatchable : normalizedStatus === "disabled" ? !tool.enabled : normalizedStatus === "unavailable" ? !tool.dispatchable : true));
    const total = tools.length;
    const pageTools = tools.slice(request.offset, request.offset + request.pageSize);
    const healthRows = pageTools.length
      ? await this.prisma.toolHealth.findMany({
          where: {
            environmentId: scope.environmentId,
            OR: pageTools.map((tool) => ({ toolId: tool.toolId, entityExternalId: tool.sourceEntityId })),
          },
        })
      : [];
    const healthByKey = new Map<string, any>();
    for (const h of healthRows as Array<{
      toolId: string;
      entityExternalId: string | null;
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
      healthByKey.set(`${h.toolId}:${h.entityExternalId ?? ""}`, h);
    }

    const rows = pageTools.map((t) => {
      const health = healthByKey.get(`${t.toolId}:${t.sourceEntityId}`);
      return {
        toolId: t.toolId,
        toolName: t.toolName,
        description: t.description,
        category: t.category ?? "uncategorized",
        paramSchema: t.paramSchema,
        entityId: t.sourceEntityId,
        entityPk: t.entityPk,
        callbackUrl: t.callbackUrl,
        enabled: t.enabled,
        dispatchable: t.dispatchable,
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
    });
    const pagination = pageMetadata(total, request);
    return {
      environmentId: scope.environmentId,
      rows,
      items: rows,
      total,
      limit: request.pageSize,
      offset: request.offset,
      hasMore: pagination.hasNext,
      pagination,
      aggregates,
      filters: { search: request.search, category: category ?? null, status: normalizedStatus, entityId: entityId ?? null },
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
    // SECURITY (audit authz-2026-07-22 F3) — flips a tool env-wide for all agents;
    // operator/dashboard-only.
    requireOperator(scope);
    const updated = await this.toolRegistry.setToolEnabled(
      this.scopeTuple(scope),
      entityId,
      toolName,
      !!body.enabled,
    );
    if (!updated) {
      throw new NotFoundException("Tool mapping not found for this scope");
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
    // SECURITY (audit authz-2026-07-22 F3) — the raw executor bypasses the
    // per-agent tool ACL and fires connected integration side-effects under the
    // entity HMAC. This wire-test surface is operator/dashboard-only; legitimate
    // non-operator tool invocation must go through the agent loop (isVisibleToAgent).
    requireOperator(scope);
    if (!body?.tool) {
      throw new BadRequestException("tool name required");
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
    // SECURITY (audit authz-2026-07-22 F3) — this Postman/wire-test dispatch
    // fires a connected tool (HMAC-signed POST to the entity callbackUrl, or the
    // executor for mcp-kind) with caller-supplied params + headers, bypassing the
    // per-agent tool ACL exactly like `/tools/execute`. The rate limit is not an
    // authz gate — gate the wire-test surface to operators (mirrors executeTool).
    requireOperator(scope);

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

    // Canonical Entity rows do not carry a legacy serviceSecret. Verify the
    // entity through Project ancestry, then dispatch through the canonical
    // executor for both wire and MCP transports.
    const entity = await this.prisma.entity.findFirst({
      where: {
        id: toolEntry.entityPk,
        projectId: scope.projectId,
        project: { organizationId: scope.organizationId },
      },
      select: { id: true },
    });
    if (!entity) {
      throw new NotFoundException({ error: "Entity not found for this tool", toolId });
    }

    const startedAt = Date.now();
    const execResult = await this.toolExecutor.execute(
      { tool: toolEntry.toolName, params: body.params ?? {}, purpose: "ui_test" },
      scope,
      { source: "wire_test" },
    );
    const durationMs = Date.now() - startedAt;
    const ok = execResult.status === "success";
    return {
      status: ok ? 200 : 502,
      headers: {},
      body: ok
        ? execResult.result ?? null
        : { error: execResult.error ?? "Tool dispatch failed" },
      durationMs,
      ...(ok ? {} : { error: execResult.error ?? "Tool dispatch failed" }),
    };
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
    const prisma = this.prisma;
    const taken = new Set<string>();
    try {
      const rows = await prisma.entity.findMany({
        where: {
          projectId: scope.projectId,
          project: { organizationId: scope.organizationId },
          externalId: { in: candidates },
        },
        select: { externalId: true },
      });
      for (const r of rows as Array<{ externalId: string }>) {
        taken.add(r.externalId);
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
      // MCP-connected-entity (design Commit 5 / §1.5a). Omit or "wire" for the
      // classic inbound platools relationship; "mcp" for an OUTBOUND MCP client
      // (Composio et al.). For "mcp", the outbound endpoint arrives as
      // mcpClient.url (NOT mcpUrls), serviceSecret is auto-generated-and-ignored,
      // and mcpUrls is optional.
      connectionKind?: "wire" | "mcp";
      mcpClient?: {
        transport?: string;
        url?: string | null;
        credsSecretKey?: string | null;
        headersTemplate?: unknown;
      };
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

    const connectionKind = body.connectionKind === "mcp" ? "mcp" : "wire";
    const mcpUrls = body.mcpUrls || [];

    if (connectionKind === "mcp") {
      // §1.5a — relax the wire "mcpUrls minItems:1" rule for the mcp kind: the
      // endpoint rides mcpClient.url, so mcpUrls is legitimately []. Validate
      // the outbound transport config instead.
      const transport = body.mcpClient?.transport;
      if (!transport || typeof transport !== "string") {
        throw new HttpException(
          {
            error: "invalid_mcp_client",
            message:
              "connectionKind 'mcp' requires mcpClient.transport " +
              "(remote-http | remote-sse | hosted-*).",
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      if (
        (transport === "remote-http" || transport === "remote-sse") &&
        !body.mcpClient?.url
      ) {
        throw new HttpException(
          {
            error: "invalid_mcp_client",
            message: `mcpClient.url is required for transport "${transport}".`,
          },
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    // NOTE: the wire path preserves its historical behavior — this REST
    // endpoint never enforced a minItems:1 on mcpUrls (only the entities.register
    // MCP tool schema did), so we do NOT tighten it here. §1.5a's "keep minItems
    // for wire" applies to that MCP tool schema, not this endpoint.

    let entity: any;
    try {
      entity = await this.authService.registerEntity({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        entityId: body.entityId,
        displayName: body.displayName,
        mcpUrls,
        serviceSecret: body.serviceSecret || "auto",
        connectionKind,
        ...(connectionKind === "mcp"
          ? {
              mcpClient: {
                transport: body.mcpClient!.transport as string,
                url: body.mcpClient?.url ?? null,
                credsSecretKey: body.mcpClient?.credsSecretKey ?? null,
                headersTemplate: body.mcpClient?.headersTemplate,
              },
            }
          : {}),
      }, scope);
    } catch (err: any) {
      if (err?.statusCode === 409) {
        throw new HttpException(err.message, HttpStatus.CONFLICT);
      }
      if (err?.statusCode === 400) {
        throw new HttpException(err.message, HttpStatus.BAD_REQUEST);
      }
      throw err;
    }

    // Kick discovery for mcp entities (fire-and-forget — like the old
    // controller did). tools/list registers into the shared matrix per env and
    // stamps connectionStatus="connected", so census/list don't show the entity
    // disconnected forever (§1.5a / §5).
    if (connectionKind === "mcp" && this.entityMcpDiscovery && entity?.id) {
      void this.entityMcpDiscovery
        .discover(entity.id)
        .catch((e: any) =>
          this.logger.warn(
            `initial MCP discovery for entity ${entity.id} failed: ${e?.message ?? e}`,
          ),
        );
    }
    return entity;
  }

  /**
   * MCP-connected-entity (design Commit 5 / §5) — manual "refresh discovery"
   * action. Re-runs the outbound tools/list round-trip for a `connectionKind
   * === "mcp"` entity across every project environment, re-registering +
   * pruning the shared tool matrix and re-stamping connectionStatus. Operators
   * hit this after rotating an upstream key or when a server adds/removes tools
   * between periodic sweeps. Idempotent-replace.
   */
  @Post("entities/:entityId/refresh-discovery")
  async refreshEntityDiscovery(
    @Req() req: Request,
    @Param("entityId") entityId: string,
  ) {
    const scope = this.getScope(req);
    // Operator-only — discovery reaches out to an external endpoint with the
    // entity's resolved credentials; same trust posture as registration.
    requireOperator(scope);
    const entity = await this.authService.getEntity(
      scope.organizationId,
      scope.projectId,
      entityId,
    );
    if (!entity) {
      throw new NotFoundException({ error: "Entity not found", entityId });
    }
    if ((entity as { connectionKind?: string }).connectionKind !== "mcp") {
      throw new HttpException(
        {
          error: "not_mcp_entity",
          message:
            "Discovery refresh only applies to connectionKind='mcp' entities.",
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!this.entityMcpDiscovery) {
      throw new HttpException(
        { error: "discovery_unavailable" },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const result = await this.entityMcpDiscovery.discover(
      (entity as { id: string }).id,
    );
    return { entityId: (entity as { entityId: string }).entityId, ...result };
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
      scope,
    );
    if (!result) {
      throw new NotFoundException({ error: "Entity not found", entityId });
    }
    // Force-close any live WS sessions still authenticated with the OLD
    // secret. Without this, an entity backend that already established
    // a connection keeps serving tool-calls with the rotated-out secret
    // indefinitely (handshake-time auth only, no per-message revalidation),
    // which defeats the purpose of "rotating" the secret.
    const closed = this.toolSync.disconnectEntity(
      scope.organizationId,
      scope.projectId,
      result.entityId,
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
    const entity = await this.authService.getEntity(
      scope.organizationId,
      scope.projectId,
      entityId,
    );
    if (!entity) {
      throw new NotFoundException({ error: "Entity not found", entityId });
    }
    const externalId = (entity as { entityId: string }).entityId;
    const toolName = (body?.toolName || "ping").trim();
    if (!toolName) {
      throw new BadRequestException("toolName is required");
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
        // EOBD.97 wire-test attributes its audit row. NO endUserId is
        // synthesized here (design §3.1 row iv-b) — for an mcp-kind entity a
        // {{endUserId}} tool fails closed at the §3.2 guard, which is correct.
        { source: "wire_test" },
      );
      return {
        status: result.status,
        latencyMs: Date.now() - startedAt,
        result: result.status === "success" ? result.result : undefined,
        error: result.status !== "success" ? result.error : undefined,
        request: {
          url: `(internal dispatch) entity=${externalId}`,
          headers: {
            "X-Platos-Entity-Id": externalId,
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
          url: `(internal dispatch) entity=${externalId}`,
          headers: { "X-Platos-Entity-Id": externalId, "X-Platos-Tool": toolName },
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
    if (!entity) {
      throw new NotFoundException({ error: "Entity not found", entityId });
    }
    const externalId = (entity as { entityId: string }).entityId;
    const connected = this.toolSync.isEntityConnected(externalId, scope.environmentId);
    const connectedInOtherEnv =
      !connected &&
      this.toolSync
        .getConnectedSources()
        .some(
          (s) =>
            s.entityId === externalId &&
            s.organizationId === scope.organizationId &&
            s.projectId === scope.projectId &&
            s.environmentId !== scope.environmentId,
        );
    const { serviceSecret, serviceSecretHash, ...safeEntity } = entity as any;
    return { ...safeEntity, liveConnected: connected, connectedInOtherEnv };
  }

  @Get("entities")
  async listEntities(
    @Req() req: Request,
    @Query("connectionKind") connectionKind?: string,
    @Query("page") pageRaw?: string,
    @Query("limit") limitRaw?: string,
    @Query("offset") offsetRaw?: string,
    @Query("search") searchRaw?: string,
  ) {
    const scope = this.getScope(req);
    const request = parsePageRequest({ page: pageRaw, limit: limitRaw, offset: offsetRaw, search: searchRaw });
    const result = await this.authService.listEntitiesPage(scope.organizationId, scope.projectId, {
      limit: request.pageSize,
      offset: request.offset,
      search: request.search,
      connectionKind,
    });
    const connectedIds = new Set(this.toolSync.getConnectedEntitiesInEnv(scope.environmentId));
    const entities = result.entities.map((e: any) => {
      const { serviceSecret, serviceSecretHash, ...safe } = e;
      return { ...safe, liveConnected: connectedIds.has(e.entityId) };
    });
    const pagination = pageMetadata(result.total, request);
    return {
      entities,
      items: entities,
      total: result.total,
      limit: request.pageSize,
      offset: request.offset,
      hasMore: pagination.hasNext,
      pagination,
      filters: { search: request.search, connectionKind: connectionKind ?? null },
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
      throw new HttpException(
        {
          error: "unsupported",
          message: "Entity-level agent allow-lists are not supported.",
        },
        HttpStatus.NOT_IMPLEMENTED,
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
        (entity as { entityId: string }).entityId,
        { allowedOrigins: deduped },
      );
    }

    // The canonical Entity graph has no testCredentials field. Do not persist
    // secret material in an unrelated JSON column.
    if (body.testCredentials !== undefined) {
      throw new HttpException(
        { error: "unsupported", message: "Entity test credentials are not supported." },
        HttpStatus.NOT_IMPLEMENTED,
      );
    }

    const updated = await this.authService.getEntity(
      scope.organizationId,
      scope.projectId,
      (entity as { entityId: string }).entityId,
    );
    return updated;
  }

  /** Legacy route retained as an explicit unsupported boundary. */
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
    res.status(HttpStatus.NOT_IMPLEMENTED).json({
      error: "unsupported",
      message: "Entity test credentials are not supported.",
    });
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
    requireOperator(scope);
    const entity = await this.authService.getEntity(
      scope.organizationId,
      scope.projectId,
      entityId,
    );
    if (!entity) {
      throw new NotFoundException({ error: "Entity not found", entityId });
    }
    const prisma = this.prisma;
    const entityPk = (entity as { id: string }).id;
    const externalId = (entity as { entityId: string }).entityId;
    const [config, bearerTokenCount] = await Promise.all([
      prisma.entityMcpConfig.findUnique({ where: { entityId: entityPk } }),
      prisma.mcpBearerToken.count({
        where: { entityId: entityPk, revokedAt: null },
      }),
    ]);
    if (!config) {
      // Default: MCP is disabled by default per PIFSP-21 decisions.
      return {
        entityPk,
        entityId: externalId,
        enabled: false,
        identityMode: "bearer",
        identityProviders: [],
        bearerTokenCount,
        branding: {},
        toolAllowlist: [],
        consentCopy: null,
        redirectUriAllowlist: [],
        rateLimitPerMinute: 60,
        injectMcpContext: false,
        exists: false,
      };
    }
    return {
      entityPk: config.entityId,
      entityId: externalId,
      enabled: config.enabled,
      identityMode: config.identityMode,
      identityProviders: config.identityProviders,
      bearerTokenCount,
      branding: config.branding,
      toolAllowlist: config.toolAllowlist,
      consentCopy: null,
      redirectUriAllowlist: config.redirectUriAllowlist,
      rateLimitPerMinute: config.rateLimitPerMinute,
      injectMcpContext: config.injectMcpContext,
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
      identityMode?: string;
      identityProviders?: unknown;
      branding?: Record<string, unknown> | null;
      toolAllowlist?: string[];
      consentCopy?: string | null;
      redirectUriAllowlist?: string[];
      rateLimitPerMinute?: number;
      injectMcpContext?: boolean;
    },
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const entity = await this.authService.getEntity(
      scope.organizationId,
      scope.projectId,
      entityId,
    );
    if (!entity) {
      throw new NotFoundException({ error: "Entity not found", entityId });
    }
    const entityPk = (entity as { id: string }).id;
    const externalId = (entity as { entityId: string }).entityId;
    const prisma = this.prisma;

    const update: Record<string, unknown> = {};
    if (typeof body.enabled === "boolean") update.enabled = body.enabled;
    if (body.identityMode !== undefined) update.identityMode = validateMcpIdentityMode(body.identityMode);
    if (body.identityProviders !== undefined) {
      update.identityProviders = validateIdentityProviders(body.identityProviders);
    }
    if (body.branding !== undefined) update.branding = body.branding ?? {};
    if (Array.isArray(body.toolAllowlist)) {
      update.toolAllowlist = body.toolAllowlist
        .filter((x) => typeof x === "string" && x.length > 0)
        .slice(0, 500);
    }
    if (Array.isArray(body.redirectUriAllowlist)) {
      update.redirectUriAllowlist = body.redirectUriAllowlist
        .filter((x) => typeof x === "string" && x.length > 0)
        .slice(0, 50);
    }
    if (typeof body.rateLimitPerMinute === "number") {
      update.rateLimitPerMinute = Math.max(1, Math.min(10000, Math.floor(body.rateLimitPerMinute)));
    }
    if (typeof body.injectMcpContext === "boolean") {
      update.injectMcpContext = body.injectMcpContext;
    }

    // Upsert so the first PATCH auto-creates the row.
    await prisma.entityMcpConfig.upsert({
      where: { entityId: entityPk },
      create: {
        entityId: entityPk,
        enabled: typeof update.enabled === "boolean" ? update.enabled : false,
        identityMode:
          typeof update.identityMode === "string" ? update.identityMode : "bearer",
        identityProviders: update.identityProviders ?? [],
        branding: update.branding ?? {},
        toolAllowlist: (update.toolAllowlist as string[] | undefined) ?? [],
        redirectUriAllowlist:
          (update.redirectUriAllowlist as string[] | undefined) ?? [],
        rateLimitPerMinute: (update.rateLimitPerMinute as number | undefined) ?? 60,
        injectMcpContext: (update.injectMcpContext as boolean | undefined) ?? false,
      },
      update,
    });

    const [fresh, bearerTokenCount] = await Promise.all([
      prisma.entityMcpConfig.findUnique({ where: { entityId: entityPk } }),
      prisma.mcpBearerToken.count({
        where: { entityId: entityPk, revokedAt: null },
      }),
    ]);
    if (!fresh) {
      throw new ServiceUnavailableException("Failed to load canonical entity MCP configuration");
    }
    return {
      entityPk,
      entityId: externalId,
      enabled: fresh.enabled,
      identityMode: fresh.identityMode,
      identityProviders: fresh.identityProviders,
      bearerTokenCount,
      branding: fresh.branding,
      toolAllowlist: fresh.toolAllowlist,
      consentCopy: null,
      redirectUriAllowlist: fresh.redirectUriAllowlist,
      rateLimitPerMinute: fresh.rateLimitPerMinute,
      injectMcpContext: fresh.injectMcpContext,
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

  @Get("monitoring/cost/user/:userId")
  async getUserCost(
    @Req() req: Request,
    @Param("userId") userId: string,
    @Query("date") date?: string,
  ) {
    const scope = this.getScope(req);
    // Operator-only — this exposes another end-user's spend (mirrors the
    // scope-cost dashboard gate). Reads the cost:user rollup recordUsage writes.
    requireOperator(scope);
    return this.costService.getUserDailyCost(this.scopeTuple(scope), userId, date);
  }

  @Get("monitoring/cost/thread/:threadId")
  async getThreadCost(@Req() req: Request, @Param("threadId") threadId: string) {
    // SECURITY (audit H2) — cross-TENANT IDOR: this took no scope and read a
    // threadId-only Redis key, so any threadId leaked another org's spend.
    // Scope-gate the thread first (mirrors getThreadTrace below), 404 on miss.
    const scope = this.getScope(req);
    const thread = await this.conversationService.getThread(threadId, scope as any);
    if (!thread) {
      throw new NotFoundException("Thread not found");
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
    // SECURITY (audit authz-2026-07-22 F4) — buildThreadTrace filters by the
    // (org,project,env) tuple alone, so any co-tenant token with a victim
    // threadId read the victim's full messages+spans+cost. Ownership-gate the
    // thread first (mirrors getThreadCost / audit H2): end-users only their own
    // thread; operators any in-scope thread via allUsers.
    const thread = await this.conversationService.getThread(threadId, scope as any, {
      allUsers: scope.principal === "operator",
    });
    if (!thread) {
      throw new NotFoundException("Thread not found");
    }
    const trace = await this.traceService.buildThreadTrace(this.scopeTuple(scope), threadId);
    if (!trace) {
      throw new NotFoundException("Thread not found");
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
    @Query("offset") offset?: string,
    @Query("search") search?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const request = parsePageRequest({ limit, offset, search });
    const parsedDays = parsePositiveIntegerFilter(days, "days", { defaultValue: 30, maximum: 3650 });
    const allRows = await this.costService.getCostByModel(this.scopeTuple(scope), {
      days: parsedDays,
      limit: 1_000_000,
    });
    const matchingRows = request.search
      ? allRows.filter((row) => row.model.toLowerCase().includes(request.search!.toLowerCase()))
      : allRows;
    const rows = matchingRows.slice(request.offset, request.offset + request.pageSize);
    const pagination = pageMetadata(matchingRows.length, request);
    return { rows, items: rows, total: matchingRows.length, limit: request.pageSize, offset: request.offset, hasMore: pagination.hasNext, pagination, filters: { days: parsedDays, search: request.search }, fetchedAt: new Date().toISOString() };
  }

  /**
   * Cost rollup by agent. Theme E.3.
   */
  @Get("monitoring/cost-by-agent")
  async costByAgent(
    @Req() req: Request,
    @Query("days") days?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("search") search?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const request = parsePageRequest({ limit, offset, search });
    const parsedDays = parsePositiveIntegerFilter(days, "days", { defaultValue: 30, maximum: 3650 });
    const allRows = await this.costService.getCostByAgent(this.scopeTuple(scope), {
      days: parsedDays,
      limit: 1_000_000,
    });
    const matchingRows = request.search
      ? allRows.filter((row) => [row.agentId, row.agentName].some((value) => String(value ?? "").toLowerCase().includes(request.search!.toLowerCase())))
      : allRows;
    const rows = matchingRows.slice(request.offset, request.offset + request.pageSize);
    const pagination = pageMetadata(matchingRows.length, request);
    return { rows, items: rows, total: matchingRows.length, limit: request.pageSize, offset: request.offset, hasMore: pagination.hasNext, pagination, filters: { days: parsedDays, search: request.search }, fetchedAt: new Date().toISOString() };
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
    const prisma = this.prisma;
    if (!prisma) return { rows: [], windowHours: 24, fetchedAt: new Date().toISOString() };
    const limit = Math.min(20, Math.max(1, limitRaw ? parseInt(limitRaw, 10) || 5 : 5));
    const since = new Date(Date.now() - 24 * 86_400_000);

    // Aggregate memory rows by agentId + kind (last 24h)
    const rows: Array<{ agentId: string; kind: string; confidence: number | null; createdAt: Date; id: string; content: string }> =
      await prisma.memory.findMany({
        where: {
          environmentId: scope.environmentId,
          agent: {
            projectId: scope.projectId,
            project: { organizationId: scope.organizationId },
          },
          createdAt: { gte: since },
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
      ? await prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } })
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
    const prisma = this.prisma;
    if (!prisma) return { users: [], nextCursor: null, fetchedAt: new Date().toISOString() };

    const limit = Math.min(100, Math.max(1, limitRaw ? parseInt(limitRaw, 10) || 50 : 50));
    const sinceDays = Math.min(90, Math.max(1, sinceDaysRaw ? parseInt(sinceDaysRaw, 10) || 30 : 30));
    const since = new Date(Date.now() - sinceDays * 86_400_000);
    const cost7dSince = new Date(Date.now() - 7 * 86_400_000);

    // 1. Thread-level aggregation by userId
    const canonicalThreadRows = await prisma.thread.findMany({
      where: {
        environmentId: scope.environmentId,
        agent: {
          projectId: scope.projectId,
          project: { organizationId: scope.organizationId },
        },
        ...(agentIdFilter ? { agentId: agentIdFilter } : {}),
        updatedAt: { gte: since },
      },
      select: { endUserId: true, agentId: true, id: true, createdAt: true },
    });
    const threadRows = canonicalThreadRows.map((thread) => ({
      userId: thread.endUserId,
      agentId: thread.agentId,
      id: thread.id,
      createdAt: thread.createdAt,
    }));

    // 2. Turn (user-message) counts + lastActive per userId
    const msgRows: Array<{ threadId: string; createdAt: Date }> = await prisma.turn.findMany({
      where: {
        thread: {
          environmentId: scope.environmentId,
          agent: {
            projectId: scope.projectId,
            project: { organizationId: scope.organizationId },
          },
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
        // WIN-134 — derived by the ledger, once. The governance page used to
        // subtract the cache lanes itself over these same rows, and the chat
        // inspector subtracted them again per step, so the same label showed
        // 3 on one panel and 9 on another for one turn.
        noCacheInputTokens: r.noCacheInputTokens,
        tasks: r.tasks,
      },
    ]));

    // 4. Safety events (7d) per userId
    const safetyRows = await prisma.safetyEvent.findMany({
      where: {
        environmentId: scope.environmentId,
        createdAt: { gte: cost7dSince },
      },
      select: { endUserId: true, metadata: true },
    });

    // 5a. Canonical EndUser display name / verified identity profile.
    const endUserRows = await prisma.endUser.findMany({
      where: {
        organizationId: scope.organizationId,
        id: { in: [...new Set(threadRows.map((thread) => thread.userId))] },
      },
      select: {
        id: true,
        displayName: true,
        identities: {
          where: { disabledAt: null },
          select: { issuer: true, channel: true, subject: true, profile: true },
        },
      },
    });
    const aliasMap = new Map<string, string>();
    const externalUserIdMap = new Map<string, string>();
    const canonicalByExternalUserId = new Map<string, string>();
    for (const eu of endUserRows) {
      const externalIdentity = eu.identities.find(
        (identity) =>
          identity.issuer === EXTERNAL_END_USER_IDENTITY.issuer &&
          identity.channel === EXTERNAL_END_USER_IDENTITY.channel,
      );
      if (externalIdentity) {
        externalUserIdMap.set(eu.id, externalIdentity.subject);
        canonicalByExternalUserId.set(externalIdentity.subject, eu.id);
      }
      const profileValue = eu.identities
        .map((identity) => identity.profile)
        .find((value) =>
          !!value && typeof value === "object" && !Array.isArray(value),
        );
      const profile = profileValue as unknown as Record<string, unknown> | undefined;
      const email = typeof profile?.["email"] === "string" ? profile["email"] : null;
      const alias = eu.displayName || email;
      if (alias) aliasMap.set(eu.id, alias);
    }
    const safetyMap = new Map<string, number>();
    for (const safety of safetyRows) {
      const metadata = safety.metadata && typeof safety.metadata === "object" && !Array.isArray(safety.metadata)
        ? safety.metadata as Record<string, unknown>
        : null;
      const adapter = metadata?.["__platosSafety"];
      const externalUserId = adapter && typeof adapter === "object" && !Array.isArray(adapter)
        ? (adapter as Record<string, unknown>)["userId"]
        : null;
      const canonicalUserId = safety.endUserId ?? (
        typeof externalUserId === "string"
          ? canonicalByExternalUserId.get(externalUserId) ?? null
          : null
      );
      if (canonicalUserId) {
        safetyMap.set(canonicalUserId, (safetyMap.get(canonicalUserId) ?? 0) + 1);
      }
    }

    // 5b. Fallback: profile aliases from PlatosMemory (kind=profile, metadata.name)
    const profileRows = await prisma.memory.findMany({
      where: {
        environmentId: scope.environmentId,
        kind: "profile",
      },
      select: { endUserId: true, content: true, metadata: true },
    });
    for (const p of profileRows) {
      if (aliasMap.has(p.endUserId)) continue; // EndUser takes priority
      const meta = p.metadata as Record<string, unknown> | null;
      if (meta?.profileKey === "name" || p.content?.startsWith("Name:")) {
        const name = String(meta?.value ?? p.content.replace(/^Name:\s*/i, "")).trim();
        if (name) aliasMap.set(p.endUserId, name);
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
      const externalUserId = externalUserIdMap.get(b.userId) ?? null;
      const tokens = (externalUserId ? tokensMap.get(externalUserId) : undefined) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
        noCacheInputTokens: 0,
        tasks: 0,
      };
      return {
        userId: b.userId,
        externalUserId,
        alias: aliasMap.get(b.userId) ?? null,
        totalConversations: b.threadIds.size,
        agentsTouched: b.agentIds.size,
        totalTurns: b.turns,
        lastActiveAt: b.lastActiveAt.toISOString(),
        cost7dCents: externalUserId ? costMap.get(externalUserId) ?? 0 : 0,
        // PRELAUNCH-A1-10 — token breakdown for the monitoring table.
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheReadInputTokens: tokens.cacheReadInputTokens,
        cacheCreationInputTokens: tokens.cacheCreationInputTokens,
        reasoningTokens: tokens.reasoningTokens,
        noCacheInputTokens: tokens.noCacheInputTokens,
        // Completed turns, from the ledger. `totalTurns` above counts every
        // Turn row including the ones that never reached a model.
        tasks: tokens.tasks,
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
    const prisma = this.prisma;
    if (!prisma) return { agents: [], fetchedAt: new Date().toISOString() };
    const sinceDays = Math.min(90, Math.max(1, sinceDaysRaw ? parseInt(sinceDaysRaw, 10) || 30 : 30));
    const since = new Date(Date.now() - sinceDays * 86_400_000);

    // Threads in scope within window
    const canonicalThreads = await prisma.thread.findMany({
        where: {
          environmentId: scope.environmentId,
          agent: {
            projectId: scope.projectId,
            project: { organizationId: scope.organizationId },
          },
          updatedAt: { gte: since },
        },
        select: { id: true, agentId: true, endUserId: true, createdAt: true, updatedAt: true },
      });
    const threads = canonicalThreads.map((thread) => ({
      id: thread.id,
      agentId: thread.agentId,
      userId: thread.endUserId,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    }));

    // Agent names + model
    const agentIds = [...new Set(threads.map((t) => t.agentId))];
    const agentBindings = await prisma.agentBinding.findMany({
      where: { environmentId: scope.environmentId, agentId: { in: agentIds } },
      select: {
        agent: { select: { id: true, name: true } },
        activeAgentVersion: { select: { model: true } },
      },
    });
    const agentRows = agentBindings.map((binding) => ({
      id: binding.agent.id,
      name: binding.agent.name,
      model: binding.activeAgentVersion.model,
    }));
    const agentMeta = new Map(agentRows.map((a: { id: string; name: string; model: string | null }) => [a.id, a]));

    // User-turn counts per agentId (proxy for "turns")
    const msgRows: Array<{ threadId: string }> = await prisma.turn.findMany({
      where: {
        thread: {
          environmentId: scope.environmentId,
          agent: {
            projectId: scope.projectId,
            project: { organizationId: scope.organizationId },
          },
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
    const prisma = this.prisma;
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
        prisma.thread.findMany({
          where: {
            environmentId: scope.environmentId,
            agent: {
              projectId: scope.projectId,
              project: { organizationId: scope.organizationId },
            },
            updatedAt: { gte: since },
          },
          select: { id: true, agentId: true },
        }),
        // All-time last-active per agent (max thread.updatedAt) — one aggregate
        // row per agent, so "Last active" stays truthful for dormant agents.
        prisma.thread.groupBy({
          by: ["agentId"],
          where: {
            environmentId: scope.environmentId,
            agent: {
              projectId: scope.projectId,
              project: { organizationId: scope.organizationId },
            },
          },
          _max: { updatedAt: true },
        }),
        // Canonical message projection: each Turn contributes its input and at
        // most one assistant side. Steps are implementation detail within that
        // assistant response, not additional chat messages.
        prisma.turn.findMany({
          where: {
            createdAt: { gte: since },
            thread: {
              environmentId: scope.environmentId,
              agent: {
                projectId: scope.projectId,
                project: { organizationId: scope.organizationId },
              },
            },
          },
          select: {
            threadId: true,
            inputText: true,
            input: true,
            outputText: true,
            output: true,
            _count: { select: { steps: true } },
          },
        }),
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
    for (const turn of msgRows) {
      const aid = threadIdToAgent.get(turn.threadId);
      if (!aid) continue;
      const projectedMessages =
        (turn.inputText !== null || turn.input !== null ? 1 : 0) +
        (turn.outputText !== null || turn.output !== null || turn._count.steps > 0 ? 1 : 0);
      messagesPerAgent.set(aid, (messagesPerAgent.get(aid) ?? 0) + projectedMessages);
    }

    // all-time last active per agent
    const lastActiveByAgent = new Map<string, Date | null>();
    for (const g of lastActiveGroups) lastActiveByAgent.set(g.agentId, g._max?.updatedAt ?? null);

    // cost + tokens per agent — straight off the ledger's rollup, including
    // the task count, so this card and the usage page cannot disagree.
    const costByAgent = new Map(
      costRows.map((r) => [
        r.agentId,
        {
          costCents: r.costCents,
          totalTokens: r.inputTokens + r.outputTokens,
          tasks: r.tasks,
        },
      ]),
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
        tasks: cost?.tasks ?? 0,
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
    const prisma = this.prisma;
    if (!prisma) throw new ServiceUnavailableException("Monitoring service unavailable");

    const cost7dSince = new Date(Date.now() - 7 * 86_400_000);
    const cost30dSince = new Date(Date.now() - 30 * 86_400_000);

    const endUserRow = await prisma.endUser.findFirst({
      where: {
        id: targetUserId,
        organizationId: scope.organizationId,
        ...currentEnvironmentEndUserPresence(scope.environmentId),
      },
      select: {
        id: true,
        displayName: true,
        identities: {
          where: { disabledAt: null },
          select: { issuer: true, channel: true, subject: true, profile: true },
        },
      },
    });
    if (!endUserRow) throw new NotFoundException("End user not found in this Environment");
    const externalUserId = endUserRow.identities.find(
      (identity) =>
        identity.issuer === EXTERNAL_END_USER_IDENTITY.issuer &&
        identity.channel === EXTERNAL_END_USER_IDENTITY.channel,
    )?.subject ?? null;
    const emailIdentity = endUserRow.identities.find((identity) => identity.channel === "email");
    const profileEmail = endUserRow.identities
      .map((identity) => identity.profile)
      .map((value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as unknown as Record<string, unknown>)["email"]
          : null,
      )
      .find((value): value is string => typeof value === "string") ?? null;
    const endUserEmail = emailIdentity?.subject ?? profileEmail;

    // Threads for this user
    const threads: Array<{
      id: string;
      agentId: string;
      title: string | null;
      createdAt: Date;
      updatedAt: Date;
      status: string;
    }> = await prisma.thread.findMany({
      where: {
        environmentId: scope.environmentId,
        endUserId: targetUserId,
        agent: {
          projectId: scope.projectId,
          project: { organizationId: scope.organizationId },
        },
      },
      select: { id: true, agentId: true, title: true, createdAt: true, updatedAt: true, status: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });

    // Agent names
    const agentIds = [...new Set(threads.map((t) => t.agentId))];
    const agentRows: Array<{ id: string; name: string }> = await prisma.agent.findMany({
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
      await prisma.memory.findMany({
        where: {
          environmentId: scope.environmentId,
          endUserId: targetUserId,
          kind: "profile",
        },
        select: { id: true, kind: true, content: true, metadata: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      });

    // Risk events (7d)
    const riskEvents = externalUserId
      ? await this.safetyEventService.list(this.scopeTuple(scope), {
          userId: externalUserId,
          limit: 50,
        })
      : { rows: [] };

    // Cost
    const cost7dRows = await this.costService.getCostByUser(this.scopeTuple(scope), { days: 7, limit: 500 });
    const cost30dRows = await this.costService.getCostByUser(this.scopeTuple(scope), { days: 30, limit: 500 });
    const cost7dCents = externalUserId
      ? cost7dRows.find((r) => r.userId === externalUserId)?.costCents ?? 0
      : 0;
    const cost30dCents = externalUserId
      ? cost30dRows.find((r) => r.userId === externalUserId)?.costCents ?? 0
      : 0;

    // Ratings summary
    // PlatosMessageRating has direct scope + userId columns — no relation needed.
    const ratings: Array<{ rating: number }> = await prisma.messageRating.findMany({
      where: {
        environmentId: scope.environmentId,
        endUserId: targetUserId,
      },
      select: { rating: true },
    });
    const ratingsUps = ratings.filter((r) => r.rating > 0).length;
    const ratingsDowns = ratings.filter((r) => r.rating < 0).length;

    // Memory count by kind
    const memoryCounts = await prisma.memory.groupBy({
        by: ["kind"],
        where: {
          environmentId: scope.environmentId,
          endUserId: targetUserId,
        },
        _count: { id: true },
      });
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
      externalUserId,
      displayName: endUserRow.displayName ?? null,
      email: endUserEmail,
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
    const endUser = await this.prisma.endUser.findFirst({
      where: {
        id: targetUserId,
        organizationId: scope.organizationId,
        ...currentEnvironmentEndUserPresence(scope.environmentId),
      },
      select: {
        identities: {
          where: EXTERNAL_END_USER_IDENTITY,
          select: { subject: true },
          take: 1,
        },
      },
    });
    if (!endUser) throw new NotFoundException("End user not found in this Environment");
    const externalUserId = endUser.identities[0]?.subject;
    if (!externalUserId) throw new NotFoundException("External user identity not found");
    return this.budgetService.getUserConsumptionSummary(scope, externalUserId);
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
    const prisma = this.prisma;
    if (!prisma) throw new ServiceUnavailableException("Monitoring service unavailable");

    const endUser = await prisma.endUser.findFirst({
      where: {
        id: targetUserId,
        organizationId: scope.organizationId,
        ...currentEnvironmentEndUserPresence(scope.environmentId),
      },
      select: {
        identities: {
          where: EXTERNAL_END_USER_IDENTITY,
          select: { subject: true },
          take: 1,
        },
      },
    });
    if (!endUser) throw new NotFoundException("End user not found in this Environment");
    const externalUserId = endUser.identities[0]?.subject ?? null;

    // Collect compact data for the prompt
    const [threads, memories, safetyRows] = await Promise.all([
      prisma.thread.findMany({
        where: {
          environmentId: scope.environmentId,
          endUserId: targetUserId,
          agent: {
            projectId: scope.projectId,
            project: { organizationId: scope.organizationId },
          },
        },
        select: { id: true, agentId: true, title: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 50,
      }),
      prisma.memory.findMany({
        where: {
          environmentId: scope.environmentId,
          endUserId: targetUserId,
        },
        select: { kind: true, content: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      prisma.safetyEvent.findMany({
        where: {
          environmentId: scope.environmentId,
          OR: [
            { endUserId: targetUserId },
            ...(externalUserId
              ? [{
                  metadata: {
                    path: ["__platosSafety", "userId"],
                    equals: externalUserId,
                  },
                }]
              : []),
          ],
        },
        select: { detector: true, severity: true, detail: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);

    // Cost data
    const costRows = await this.costService.getCostByUser(this.scopeTuple(scope), { days: 30, limit: 500 });
    const cost30d = externalUserId
      ? costRows.find((r) => r.userId === externalUserId)?.costCents ?? 0
      : 0;

    const summaryModel = "anthropic:claude-haiku-4-5-20251001";
    let summaryPrice: Awaited<ReturnType<typeof preflightModelPricing>>;
    try {
      summaryPrice = await preflightModelPricing(this.costService, summaryModel);
    } catch (error: any) {
      return {
        code: error?.code ?? "model_pricing_unavailable",
        error: error?.message ?? "Canonical model pricing is unavailable.",
      };
    }

    // Resolve Anthropic key
    const anthropicKey = await this.agentService.resolvePublicApiKey(this.scopeTuple(scope), "anthropic");
    if (!anthropicKey) {
      return {
        error: "Anthropic provider not configured for this environment. Add an Anthropic API key under Providers to enable AI summaries.",
      };
    }

    // Build compact context
    const agentIds = [...new Set((threads as Array<{ agentId: string }>).map((t) => t.agentId))];
    const agentRows: Array<{ id: string; name: string }> = await prisma.agent.findMany({
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
      const generated = await generateText({
        model: anthropicClient("claude-haiku-4-5-20251001"),
        messages: [{ role: "user", content: prompt }],
        maxOutputTokens: 600,
        temperature: 0.3,
        abortSignal: reqSignal,
      });
      const usage = generated.usage;
      const inputTokens = usage?.inputTokens ?? 0;
      const outputTokens = usage?.outputTokens ?? 0;
      if (inputTokens > 0 || outputTokens > 0) {
        const pricedUsage = this.costService.priceUsageFromSnapshot(
          summaryModel,
          summaryPrice,
          inputTokens,
          outputTokens,
          usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
          usage?.inputTokenDetails?.cacheReadTokens ?? 0,
        );
        await this.costService.recordAuxiliaryCost({
          scope: this.scopeTuple(scope),
          kind: "monitoring-user-summary",
          model: summaryModel,
          costCents: pricedUsage.costCents,
          inputTokens,
          outputTokens,
          agentId: scope.agentId,
          userId: scope.userId,
        });
      }
      return { summary: generated.text.trim(), generatedAt: new Date().toISOString() };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown error";
      throw new ServiceUnavailableException(`Summary generation failed: ${msg}`);
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
    @Query("search") search?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const request = parsePageRequest({ limit, offset, search });
    const parsedSinceDays = parsePositiveIntegerFilter(sinceDays, "sinceDays", { maximum: 3650 });
    const parsedStatus = parseEnumFilter(status, "status", ["success", "failed", "timeout"] as const);
    const page = await this.toolAuditService.list(this.scopeTuple(scope), {
      threadId,
      agentId,
      toolName,
      status: parsedStatus ?? undefined,
      entityId,
      sinceDays: parsedSinceDays,
      limit: request.pageSize,
      offset: request.offset,
      search: request.search ?? undefined,
    });
    const pagination = pageMetadata(page.total, { pageSize: page.limit, offset: page.offset });
    return { ...page, items: page.rows, hasMore: pagination.hasNext, pagination, filters: { threadId, agentId, toolName, status: parsedStatus, entityId, sinceDays: parsedSinceDays ?? null, search: request.search }, fetchedAt: new Date().toISOString() };
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
    if (!row) throw new NotFoundException("Tool call not found");
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
      throw new HttpException({
        error: "rate_limited",
        message: `Replay budget exceeded: ${REPLAY_BUDGET} per ${REPLAY_WINDOW_SECONDS}s. Retry in ${Math.max(ttl, 1)}s.`,
        retryAfterSeconds: Math.max(ttl, 1),
      }, HttpStatus.TOO_MANY_REQUESTS);
    }

    const original = await this.toolAuditService.getById(this.scopeTuple(scope), callId);
    if (!original) throw new NotFoundException("Tool call not found");

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
      // MCP-as-connected-entity (design §3.1 row iii) — reconstruct the origin
      // from the stored audit row so a replayed connectionKind="mcp" tool
      // re-substitutes the SAME end user (`endUserId`) it originally ran as, and
      // OIDC identity (`mcpUserId`) is preserved. A row with no stored end user
      // fails closed on a `{{endUserId}}` template — correct: you cannot
      // silently re-attribute it. `source: "replay"` tags the replay's own row.
      {
        source: "replay",
        endUserId: original.endUserId ?? undefined,
        mcpUserId: original.mcpUserId ?? undefined,
        mcpClientId: original.mcpClientId ?? undefined,
      },
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
    @Query("search") search?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const scopeTuple = this.scopeTuple(scope);
    const request = parsePageRequest({ limit, offset, search });
    const parsedSinceDays = parsePositiveIntegerFilter(sinceDays, "sinceDays", { maximum: 3650 });
    const parsedStatus = parseEnumFilter(status, "status", ["pending", "approved", "rejected", "timed_out"] as const);
    const parsedSource = parseEnumFilter(source, "source", ["request_approval", "cancel_run", "mcp_tool_call"] as const);
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
      status: parsedStatus ?? undefined,
      source: parsedSource ?? undefined,
      sinceDays: parsedSinceDays,
      limit: request.pageSize,
      offset: request.offset,
      search: request.search ?? undefined,
    });
    const pagination = pageMetadata(page.total, { pageSize: page.limit, offset: page.offset });
    return { ...page, items: page.rows, hasMore: pagination.hasNext, pagination, filters: { threadId, agentId, status: parsedStatus, source: parsedSource, sinceDays: parsedSinceDays ?? null, search: request.search }, fetchedAt: new Date().toISOString() };
  }

  /** Fetch a single approval row — scope-gated. Theme E.6. */
  @Get("monitoring/approvals/:approvalId")
  async getApproval(@Req() req: Request, @Param("approvalId") approvalId: string) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const row = await this.approvalsService.getById(this.scopeTuple(scope), approvalId);
    if (!row) throw new NotFoundException("Approval not found");
    return row;
  }

  /**
   * LAUNCH-11 — internal compaction endpoint. Called back by the
   * `platos.compaction` trigger.dev task with `{threadId, scope}`.
   * Resolves the agent config for the thread + delegates to
   * `AgentTaskService.runCompaction`.
   *
   * Gated by `X-Platos-Internal-Auth` (same gate as other internal callbacks).
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
      // C1 FIX — the dispatching turn's resolved agent config, forwarded so
      // this callback doesn't hardcode it. Optional for pre-deploy runs.
      contextLimit?: number;
      compactThreshold?: number;
      historyMode?: string;
    },
  ) {
    const expected = env.PLATOS_INTERNAL_AUTH_TOKEN;
    if (!expected) {
      return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN not set" };
    }
    const provided = req.headers["x-platos-internal-auth"];
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
      // C1 FIX — use the config the dispatching turn already resolved and sent
      // in the payload. Previously this hardcoded contextLimit=30/threshold=40
      // and called resolveConfigForThread on the WRONG service
      // (agentTaskService has no such method → the `?.` silently no-op'd), so
      // compact-mode threads with a non-default contextLimit lost a band of
      // messages (kept neither verbatim nor summarized). Fall back to the real
      // system defaults only for a pre-deploy run that lacks the fields.
      const config: any = {
        historyMode: body.historyMode ?? "compact",
        contextLimit: typeof body.contextLimit === "number" ? body.contextLimit : 20,
        compactThreshold: typeof body.compactThreshold === "number" ? body.compactThreshold : 40,
      };
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
    const expected = env.PLATOS_INTERNAL_AUTH_TOKEN;
    if (!expected) return false;
    const provided = req.headers["x-platos-internal-auth"];
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
    if (!env.PLATOS_INTERNAL_AUTH_TOKEN) {
      res.status(503).json({ error: "PLATOS_INTERNAL_AUTH_TOKEN not set" });
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
   * @deprecated DORMANT — the callback of the retired `platos.agent.durable-
   * turn` task. Chat dispatch now runs `executionMode==="durable"` on Trigger
   * SESSIONS (`/internal/chat/stream-turn`), so nothing dispatches that task
   * anymore and nothing calls this endpoint. Retained (still functional, still
   * admin-token gated) alongside the dormant task pending removal — do NOT wire
   * new callers to it.
   *
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
    if (!env.PLATOS_INTERNAL_AUTH_TOKEN) return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN not set" };
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
      // The session worker reconstructs the turn scope from clientData
      // (`{ ...cd.scope, agentId, threadId }`), so this is exactly a
      // SessionScope plus the re-stamped agentId/threadId. It flows into the
      // RequestScope via `body.scope as any` below and rides through to the
      // tool executor's `__platos` envelope unchanged. SessionScope
      // (session-scope.ts) is the single source of truth for the carried set —
      // userToken, entityId, principal, userIdentities, sessionContext,
      // signedUserMeta.
      scope: SessionScope & { agentId?: string; threadId?: string };
    },
  ) {
    if (!env.PLATOS_INTERNAL_AUTH_TOKEN) {
      res.status(503).json({ error: "PLATOS_INTERNAL_AUTH_TOKEN not set" });
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
    if (!env.PLATOS_INTERNAL_AUTH_TOKEN) return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN not set" };
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
   * Subagent spawning — report-back callback. Invoked by the
   * `platos.agent.subrun` trigger task when a background subagent finishes.
   * WAKES THE PARENT: the child's result rides in as a synthetic
   * `[subagent_report]` message (pre-formatted by the task) and a durable
   * PARENT turn runs in-process on the parent thread — the parent then reasons
   * over the result (spawn more / synthesize / finish).
   *
   * Uses the EXACT durable-turn wake mechanism: run `executeStreamingTurn`
   * in-process on the parent thread and relay each event to the parent thread's
   * Socket.IO room via the generic `overview:event` Redis forwarder — ONE relay
   * loop, so no double-emit. Admin-token gated + `adminCallbackScopeOwns`
   * (the body's scope must own the parent agent + thread) exactly like
   * `internalDurableTurn`.
   */
  @Post("internal/subagent-report")
  async internalSubagentReport(
    @Req() req: Request,
    @Body() body: {
      agentId: string;
      /** Parent thread the report is injected into (the spawn origin). */
      threadId: string;
      /** Pre-formatted synthetic `[subagent_report]` message (from the task). */
      report: string;
      childThreadId?: string | null;
      finalStatus?: string;
      costCents?: number;
      turnsUsed?: number;
      /**
       * SECURITY (subagent depth cap) — the spawn depth of the PARENT thread
       * being woken (the reporting child's depth minus one). Stamped onto the
       * woken turn's scope so its `buildMetaTools` enforces the grandchild cap.
       * WITHOUT this, the wake turn defaults to depth 0 and can spawn a fresh
       * subtree from any level — resetting the depth counter on every
       * report-back and defeating the ≤2 cap. Runtime-derived by the subrun
       * task; absent ⇒ treated as 0 (a legitimately-root parent).
       */
      parentSpawnDepth?: number;
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
    if (!env.PLATOS_INTERNAL_AUTH_TOKEN) return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN not set" };
    if (!this.verifyAdminToken(req)) return { status: "forbidden" };
    if (!body?.report || !body?.scope || !body?.threadId) {
      return { status: "invalid", reason: "report, threadId and scope required" };
    }
    // SECURITY (audit C2) — the body's scope must own its parent agent/thread.
    if (!(await this.adminCallbackScopeOwns(body))) {
      return { status: "forbidden", reason: "scope does not own the target agent/thread" };
    }
    const start = Date.now();
    const threadId = body.threadId;
    const room = `thread:${threadId}`;
    // SECURITY (subagent depth cap) — resume the woken parent turn at the
    // parent thread's TRUE depth, not 0. `body.scope` intentionally carries no
    // spawnDepth of its own, so without this stamp the woken turn's
    // buildMetaTools would see depth 0 and permit spawning a fresh subtree from
    // any tree level — an unbounded-recursion bypass of the ≤2 cap through the
    // report-back path. The subrun task derives parentSpawnDepth server-side
    // (reporting child depth − 1). Clamp defensively.
    const wakeSpawnDepth =
      typeof body.parentSpawnDepth === "number" &&
      Number.isFinite(body.parentSpawnDepth) &&
      body.parentSpawnDepth > 0
        ? Math.floor(body.parentSpawnDepth)
        : 0;
    const wakeScope = { ...body.scope, spawnDepth: wakeSpawnDepth };
    try {
      // Wake the parent: seed a durable parent turn with the subagent report as
      // a synthetic user-role message. Relay each event to the parent thread
      // room via the generic Redis forwarder (same as internalDurableTurn) —
      // a single relay loop, so a client joined to the thread room gets each
      // event exactly once (no double-emit).
      let fullText = "";
      let messageId: string | undefined;
      let costCents = 0;
      for await (const event of this.agentTaskService.executeStreamingTurn(body.report, wakeScope as any, {
        agentId: body.agentId,
        threadId,
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
    if (!env.PLATOS_INTERNAL_AUTH_TOKEN) return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN not set" };
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
   * day. Gated by `X-Platos-Internal-Auth` so external callers can't spoof
   * prices.
   */
  @Post("monitoring/cost/catalog")
  async ingestCostCatalog(
    @Req() req: Request,
    @Body() body: { catalog: Record<string, Record<string, unknown>>; fetchedAt: string },
  ) {
    const accepted = assertCostCatalogIngestion(
      env.PLATOS_INTERNAL_AUTH_TOKEN,
      req.headers["x-platos-internal-auth"],
      body,
    );
    const result = await this.costService.ingestCatalog(
      accepted.catalog,
      accepted.fetchedAt,
    );
    return { status: "ok", ...result };
  }

  /**
   * EOBD.100 — DLQ drain endpoint. Scheduled
   * `platos.observability.dlq_drain` task POSTs here every 2 min. We
   * pop up to `maxBatch` entries off the Redis list, attempt re-insert,
   * and count per-DLQ successes + permanent failures. Permanent
   * failures (after N internal attempts) move to a `:dead` list for
   * manual operator review.
   *
   * WIN-133 — this endpoint now also drains the durable observability outbox.
   * The two queues are different in kind and the response keeps them apart:
   * the Redis span DLQ is a best-effort hold-queue that drops its oldest
   * entries under pressure, while `ObservabilityOutbox` is a Postgres table
   * that never drops a row and parks what it cannot deliver. Reporting them as
   * one number would let a bounded loss hide inside an unbounded guarantee.
   */
  @Post("monitoring/dlq/drain")
  async drainDlq(
    @Req() req: Request,
    @Body() body: { maxBatch?: number } = {},
  ) {
    const expected = env.PLATOS_INTERNAL_AUTH_TOKEN;
    if (!expected) {
      return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN not set" };
    }
    const provided = req.headers["x-platos-internal-auth"];
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

    // The outbox drain reports its own summary rather than folding into the
    // two counters above: `parked` is a number that has to be explained, and
    // `skipped` is the honest answer when the sink is absent or unreachable.
    //
    // A THROWN DRAIN IS A FAILURE, NOT A SKIP. It used to be folded into the
    // same `skipped` field the benign states use, under an HTTP 200 `ok`, and
    // the only consumer logs every `skipped` value at warn under "not an
    // error". So a drain throwing on every pass — `settle()` failing against
    // Postgres mid-loop, which aborts the pass and leaves every claimed row
    // untouched — was indistinguishable from "no observability sink
    // configured" and produced no error-level signal anywhere.
    const observability = await this.observability
      .drain(maxBatch)
      .catch((err: unknown) =>
        failedDrainSummary(`drain threw (${err instanceof Error ? err.name : "Error"})`),
      );

    return {
      // The envelope's own status. A failed outbox drain is not an `ok` pass,
      // whatever the two Redis queues did.
      status: observability.failure ? "degraded" : "ok",
      drained,
      deadLettered,
      observability,
    };
  }

  /**
   * WIN-133 — Admin: observability sink health and outbox depth.
   *
   * The endpoint `agent-runtime.module.ts` claims exists. Without it, `status()`
   * had no caller outside its own test and `tables()` had none at all, so the
   * outbox's durable backlog was invisible: `parked` in the drain summary counts
   * rows parked during THAT pass, and the claim query filters on PENDING, so a
   * row parked at 09:00 was announced once and never again.
   *
   * Same `X-Platos-Internal-Auth` gate as the drain beside it: queue depth is an
   * operational number across every tenant, not a scoped one.
   */
  @Get("monitoring/observability/status")
  async observabilityStatus(@Req() req: Request) {
    const expected = env.PLATOS_INTERNAL_AUTH_TOKEN;
    if (!expected) {
      return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN not set" };
    }
    const provided = req.headers["x-platos-internal-auth"];
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
    const report = await this.observability.status();
    return {
      status: "ok",
      sink: report.sink,
      queue: report.queue,
      ...(report.queueError ? { queueError: report.queueError } : {}),
      tables: this.observability.tables(),
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * PPR-24 — Admin: rebuild Redis cost hashes from PlatosAgentMessage
   * (Postgres is authoritative). Called by the nightly
   * `platos.cost.reconcile` trigger task.
   */
  @Post("monitoring/cost/reconcile")
  async reconcileCost(@Req() req: Request, @Body() body: { daysBack?: number } = {}) {
    const expected = env.PLATOS_INTERNAL_AUTH_TOKEN;
    if (!expected) {
      return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN not set" };
    }
    const provided = req.headers["x-platos-internal-auth"];
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
   * task. Gated by the same `X-Platos-Internal-Auth` the cost catalog
   * endpoint uses.
   */
  @Post("monitoring/approvals/expiry-sweep")
  async expireApprovals(@Req() req: Request) {
    const expected = env.PLATOS_INTERNAL_AUTH_TOKEN;
    if (!expected) {
      return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN not set" };
    }
    const provided = req.headers["x-platos-internal-auth"];
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
      this.prisma.thread.count({
        where: {
          environmentId: scope.environmentId,
          environment: {
            project: { id: scope.projectId, organizationId: scope.organizationId },
          },
        },
      }),
      this.prisma.thread.count({
        where: {
          environmentId: scope.environmentId,
          environment: {
            project: { id: scope.projectId, organizationId: scope.organizationId },
          },
          createdAt: { gte: new Date(Date.now() - 86400_000) },
        },
      }),
      this.costService.getScopeCostRange(scopeTuple, 7),
    ]);

    // Defence-in-depth scope filter. ToolHealth belongs to an Environment;
    // traverse the canonical Environment → Project relation to re-check the
    // full tuple instead of relying on a legacy RuntimeEnvironment delegate.
    const activeToolsRows: Array<{ totalCalls: number; lastCalledAt: Date | null }> =
      await this.prisma.toolHealth.findMany({
        where: {
          environmentId: scope.environmentId,
          environment: {
            project: { id: scope.projectId, organizationId: scope.organizationId },
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
          // WIN-134 — a task is ONE COMPLETED TURN. The number that made this
          // card necessary counted tool calls, so an agent that searched, read
          // three documents and replied was reported as having done five jobs.
          // It comes from the ledger's task counter, which only a completed
          // turn increments.
          id: "tasks_7d",
          label: "Tasks completed (7d)",
          value: cost7d.tasks,
          unit: "tasks",
        },
        {
          id: "tools_active_7d",
          label: "Active tools (7d)",
          value: activeToolsRows.length,
          unit: "tools",
        },
      ],
      // The lane split sums back to the spend card by construction — see
      // `laneCostsFromRollup`, where inference is the residual.
      costByLane: cost7d.byLane,
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
    @Query("page") pageRaw?: string,
    @Query("limit") limitRaw?: string,
    @Query("offset") offsetRaw?: string,
    @Query("search") searchRaw?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H1) — operator-only dashboard
    const request = parsePageRequest(
      { page: pageRaw, limit: limitRaw, offset: offsetRaw, search: searchRaw },
      { defaultPageSize: 50 },
    );
    const parsedDetector = parseEnumFilter(detector, "detector", ["pii", "injection", "grounded", "exfiltration", "tool_param", "rate_limit", "budget", "dispatcher_permission_gate"] as const);
    const parsedAction = parseEnumFilter(action, "action", ["flag", "redact", "block", "warn"] as const);
    const parsedSeverity = parseEnumFilter(severity, "severity", ["low", "medium", "high"] as const);
    const parsedSinceDays = parsePositiveIntegerFilter(sinceDays, "sinceDays", { defaultValue: 30, maximum: 365 });
    const result = await this.safetyEventService.list(this.scopeTuple(scope), {
      detector: parsedDetector ?? undefined,
      action: parsedAction ?? undefined,
      threadId,
      agentId,
      userId,
      severity: parsedSeverity ?? undefined,
      sinceDays: parsedSinceDays,
      limit: request.pageSize,
      offset: request.offset,
      search: request.search,
    });
    return {
      ...result,
      items: result.rows,
      hasMore: request.offset + result.rows.length < result.total,
      pagination: pageMetadata(result.total, request),
      filters: {
        detector: parsedDetector,
        action: parsedAction,
        severity: parsedSeverity,
        sinceDays: parsedSinceDays,
        threadId: threadId ?? null,
        agentId: agentId ?? null,
        userId: userId ?? null,
        search: request.search,
      },
    };
  }

  // ── Activity feed ─────────────────────────────────────

  /**
   * PIFSP-2 — Plato Central activity feed.
   *
   * Returns a time-sorted UNION of recent events across 5 sources:
   *   1. PlatosAgentMessage (assistant turns)
   *   2. PlatosConnectedEntity (connect/disconnect)
   *   3. PlatosMemory (extraction events, source="extractor")
   *   4. AdminAudit (immutable version-promotion events)
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
    const prisma = this.prisma;
    const limit = Math.min(50, Math.max(1, limitStr ? parseInt(limitStr, 10) : 15));
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
    const turns = await prisma.thread.findMany({
      where: {
        environmentId: scope.environmentId,
        ...(agentId ? { agentId } : {}),
        agent: {
          projectId: scope.projectId,
          project: { organizationId: scope.organizationId },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
      select: {
        id: true,
        agentId: true,
        endUserId: true,
        updatedAt: true,
        _count: { select: { turns: true } },
      },
    });
    for (const t of turns) {
      items.push({
        kind: "turn.completed",
        at: t.updatedAt.toISOString(),
        agentId: t.agentId,
        threadId: t.id,
        userId: t.endUserId,
        summary: `Thread active · ${t._count.turns} turn${t._count.turns !== 1 ? "s" : ""}`,
        severity: "info",
        payload: { turnCount: t._count.turns },
      });
    }

    // 2. Entity connect/disconnect (recent updates)
    const entities = await prisma.entity.findMany({
      where: {
        projectId: scope.projectId,
        project: { organizationId: scope.organizationId },
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
      select: { externalId: true, updatedAt: true, lastConnectedAt: true },
    });
    for (const e of entities) {
      const connected = !!e.lastConnectedAt &&
        Math.abs(new Date(e.updatedAt).getTime() - new Date(e.lastConnectedAt).getTime()) < 5000;
      items.push({
        kind: connected ? "entity.connected" : "entity.disconnected",
        at: e.updatedAt.toISOString(),
        summary: `Entity ${e.externalId} ${connected ? "connected" : "disconnected"}`,
        severity: "info",
        payload: { entityId: e.externalId },
      });
    }

    // 3. Memory extraction events
    const memories = await prisma.memory.findMany({
      where: {
        environmentId: scope.environmentId,
        source: "extractor",
        ...(agentId ? { agentId } : {}),
        agent: {
          projectId: scope.projectId,
          project: { organizationId: scope.organizationId },
        },
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

    // 4. Agent version promotions. AgentVersion.createdAt records version
    // creation, not promotion; use the immutable admin event instead.
    const promotions = await prisma.adminAudit.findMany({
      where: {
        environmentId: scope.environmentId,
        environment: {
          projectId: scope.projectId,
          project: { organizationId: scope.organizationId },
        },
        action: "agent.canary.promote",
        ...(agentId ? { subjectId: agentId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { subjectId: true, createdAt: true, before: true, after: true },
    });
    for (const promotion of promotions) {
      const after = promotion.after && typeof promotion.after === "object" && !Array.isArray(promotion.after)
        ? promotion.after as Record<string, unknown>
        : null;
      const currentVersionId = typeof after?.["currentVersionId"] === "string"
        ? after["currentVersionId"]
        : null;
      items.push({
        kind: "version.promoted",
        at: promotion.createdAt.toISOString(),
        agentId: promotion.subjectId ?? undefined,
        summary: "Canary version promoted to current",
        severity: "info",
        payload: { currentVersionId },
      });
    }

    // 5. Safety events
    const safety = await prisma.safetyEvent.findMany({
      where: {
        environmentId: scope.environmentId,
        ...(agentId ? { agentId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { agentId: true, threadId: true, createdAt: true, action: true, severity: true, detector: true },
    });
    for (const s of safety) {
      items.push({
        kind: "safety.event",
        at: s.createdAt.toISOString(),
        agentId: s.agentId ?? undefined,
        threadId: s.threadId ?? undefined,
        summary: `Safety event · ${s.action} (${s.severity})`,
        severity: s.severity === "high" ? "error" : s.severity === "medium" ? "warn" : "info",
        payload: { kind: s.action, severity: s.severity, detector: s.detector },
      });
    }

    // Sort all merged items desc by time, cap at limit
    items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return { items: items.slice(0, limit), fetchedAt: new Date().toISOString() };
  }

  // ── Budget caps ────────────────────────────────────────

  /** List every budget cap configured for the current scope. */
  @Get("budgets")
  async listBudgets(
    @Req() req: Request,
    @Query("page") pageRaw?: string,
    @Query("limit") limitRaw?: string,
    @Query("offset") offsetRaw?: string,
  ) {
    const scope = this.getScope(req);
    // SECURITY (audit H16 — budget data is operator-only financial metadata).
    requireOperator(scope);
    const request = parsePageRequest({ page: pageRaw, limit: limitRaw, offset: offsetRaw });
    const result = await this.budgetService.listPage(this.scopeTuple(scope), {
      limit: request.pageSize,
      offset: request.offset,
    });
    return {
      caps: result.items,
      items: result.items,
      total: result.total,
      limit: request.pageSize,
      offset: request.offset,
      hasMore: request.offset + result.items.length < result.total,
      pagination: pageMetadata(result.total, request),
      filters: {},
    };
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
    @Query("page") pageRaw?: string,
    @Query("limit") limitRaw?: string,
    @Query("offset") offsetRaw?: string,
  ) {
    const scope = this.getScope(req);
    // SECURITY (audit H16 — budget status is operator-only financial metadata).
    requireOperator(scope);
    const request = parsePageRequest({ page: pageRaw, limit: limitRaw, offset: offsetRaw });
    const result = await this.budgetService.evaluate(this.scopeTuple(scope), {
      agentId: agentId || undefined,
      userId: userId || scope.userId,
    });
    const total = result.caps.length;
    const caps = result.caps.slice(request.offset, request.offset + request.pageSize);
    return {
      ...result,
      caps,
      items: caps,
      total,
      limit: request.pageSize,
      offset: request.offset,
      hasMore: request.offset + caps.length < total,
      pagination: pageMetadata(total, request),
      filters: { agentId: agentId ?? null, userId: userId ?? null },
    };
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

  /** Callback-only Trigger entrypoint for durable per-channel budget delivery. */
  @Post("internal/budget-alert")
  async internalBudgetAlert(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: BudgetAlertPayload,
  ) {
    if (!env.PLATOS_INTERNAL_AUTH_TOKEN) {
      res.status(503).json({ error: "internal_auth_not_configured" });
      return;
    }
    if (!this.verifyAdminToken(req)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    try {
      const result = await this.budgetService.deliverThresholdEvent(body);
      res.status(200).json(result);
    } catch (error: any) {
      const failed = Number(error?.summary?.failed ?? 0);
      res.status(503).json({
        error: failed > 0 ? "budget_alert_delivery_failed" : "budget_alert_callback_failed",
        ...(failed > 0 ? { failed } : {}),
      });
    }
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
    const expected = env.PLATOS_INTERNAL_AUTH_TOKEN;
    if (!expected) return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN not set" };
    const provided = req.headers["x-platos-internal-auth"];
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
   * EndUser-only and idempotent per canonical (messageId, EndUser). Operator
   * principals receive RATING_ACTOR_FORBIDDEN so they cannot replace the
   * EndUser's row. Rating must be ±1; zero is not a valid vote — use DELETE.
   */
  @Post("messages/:messageId/rating")
  async rateMessage(
    @Req() req: Request,
    @Param("messageId") messageId: string,
    @Body() body: { rating: number; comment?: string | null },
  ) {
    const scope = this.getScope(req);
    if (body?.rating !== 1 && body?.rating !== -1) {
      throw new BadRequestException("rating must be 1 or -1");
    }
    try {
      const row = await this.ratingService.upsert(scope, {
        messageId,
        rating: body.rating as 1 | -1,
        comment: body.comment ?? null,
      });
      return { rating: row };
    } catch (err: any) {
      if (err instanceof RatingMutationForbiddenError) {
        throw new ForbiddenException({ code: err.code, message: err.message });
      }
      if (err instanceof RatingTargetNotFoundError) {
        throw new NotFoundException({ code: err.code, message: err.message });
      }
      throw new BadRequestException(err?.message || "Rating failed");
    }
  }

  /** Theme J.1 — remove the canonical EndUser rating; operators are denied. */
  @Delete("messages/:messageId/rating")
  async unrateMessage(@Req() req: Request, @Param("messageId") messageId: string) {
    const scope = this.getScope(req);
    try {
      const removed = await this.ratingService.remove(scope, messageId);
      return { removed };
    } catch (error) {
      if (error instanceof RatingMutationForbiddenError) {
        throw new ForbiddenException({ code: error.code, message: error.message });
      }
      if (error instanceof RatingTargetNotFoundError) {
        throw new NotFoundException({ code: error.code, message: error.message });
      }
      throw error;
    }
  }

  /** Theme J.1 — fetch the current user's vote + aggregate counts. */
  @Get("messages/:messageId/rating")
  async getMessageRating(
    @Req() req: Request,
    @Param("messageId") messageId: string,
  ) {
    const scope = this.getScope(req);
    try {
      return await this.ratingService.getForMessage(scope, messageId);
    } catch (error) {
      if (error instanceof RatingTargetNotFoundError) {
        throw new NotFoundException({ code: error.code, message: error.message });
      }
      throw error;
    }
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
      throw new BadRequestException(err?.message || "Create criterion failed");
    }
  }

  @Get("eval-criteria")
  async listCriteria(
    @Req() req: Request,
    @Query("agentId") agentId?: string,
    @Query("activeOnly") activeOnly?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("search") search?: string,
  ) {
    const scope = this.getScope(req);
    const request = parsePageRequest({ limit, offset, search });
    const parsedActiveOnly = parseBooleanFilter(activeOnly, "activeOnly") ?? false;
    const result = await this.criterionService.listPage(this.scopeTuple(scope), {
      agentId: agentId ?? undefined,
      activeOnly: parsedActiveOnly,
      limit: request.pageSize,
      offset: request.offset,
      search: request.search,
    });
    const pagination = pageMetadata(result.total, request);
    return {
      criteria: result.criteria,
      items: result.criteria,
      total: result.total,
      limit: request.pageSize,
      offset: request.offset,
      hasMore: pagination.hasNext,
      pagination,
      filters: { agentId: agentId ?? null, activeOnly: parsedActiveOnly, search: request.search },
    };
  }

  @Get("eval-criteria/:criterionId")
  async getCriterion(
    @Req() req: Request,
    @Param("criterionId") criterionId: string,
  ) {
    const scope = this.getScope(req);
    const row = await this.criterionService.findById(this.scopeTuple(scope), criterionId);
    if (!row) throw new NotFoundException("Criterion not found");
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
      throw new BadRequestException(err?.message || "Update criterion failed");
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
        throw new HttpException(err.message, HttpStatus.CONFLICT);
      }
      throw new BadRequestException(err?.message || "Eval run failed");
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
    @Query("search") search?: string,
  ) {
    const scope = this.getScope(req);
    const request = parsePageRequest({ limit, offset, search });
    const parsedSinceDays = parsePositiveIntegerFilter(sinceDays, "sinceDays", { maximum: 3650 });
    const page = await this.evalService.list(this.scopeTuple(scope), {
      agentId,
      agentVersionId,
      criterionId,
      threadId,
      runId,
      sinceDays: parsedSinceDays,
      limit: request.pageSize,
      offset: request.offset,
      search: request.search ?? undefined,
    });
    const pagination = pageMetadata(page.total, { pageSize: page.limit, offset: page.offset });
    return { ...page, items: page.rows, evals: page.rows, hasMore: pagination.hasNext, pagination, filters: { agentId, agentVersionId, criterionId, threadId, runId, sinceDays: parsedSinceDays ?? null, search: request.search }, fetchedAt: new Date().toISOString() };
  }

  @Get("evals/:evalId")
  async getEval(@Req() req: Request, @Param("evalId") evalId: string) {
    const scope = this.getScope(req);
    const row = await this.evalService.getById(this.scopeTuple(scope), evalId);
    if (!row) throw new NotFoundException("Eval not found");
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
      throw new BadRequestException(err?.message || "Create golden set failed");
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
    if (!row) throw new NotFoundException("Golden set not found");
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
      throw new BadRequestException(err?.message || "Update golden set failed");
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
      throw new BadRequestException(err?.message || "Golden set run failed");
    }
  }

  // ── Access Key management ─────────────────────────────────────────────────

  @Get("access-key")
  async getAccessKey(@Req() req: Request) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const record = await this.authService.getAccessKey(scope);
    return record;
  }

  @Post("access-key")
  async createOrRotateAccessKey(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 3 ||
      !Object.hasOwn(body, "attemptId") ||
      !Object.hasOwn(body, "keyHash") ||
      !Object.hasOwn(body, "keyPrefix")
    ) {
      throw new BadRequestException("invalid_access_key_material");
    }

    const { attemptId, keyHash, keyPrefix } = body as Record<string, unknown>;
    if (
      typeof attemptId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId) ||
      typeof keyHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(keyHash) ||
      typeof keyPrefix !== "string" ||
      !/^platos_live_[A-Za-z0-9_-]{1,12}$/.test(keyPrefix)
    ) {
      throw new BadRequestException("invalid_access_key_material");
    }

    const result = await this.authService.createOrRotateAccessKey(
      scope,
      { keyHash, keyPrefix },
    );
    if (
      !result?.key ||
      typeof result.key.id !== "string" ||
      result.key.id.trim() === "" ||
      result.key.keyPrefix !== keyPrefix ||
      result.key.environmentId !== scope.environmentId
    ) {
      throw new ServiceUnavailableException("access_key_persistence_mismatch");
    }
    return { attemptId, ...result };
  }

  @Post("access-key/origins")
  async setAllowedOrigins(@Req() req: Request, @Body() body: { origins: string[] }) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const origins = (body.origins ?? []).map((o: string) => o.trim()).filter(Boolean);
    await this.authService.setAllowedOrigins(scope, origins);
    return { ok: true, origins };
  }

  @Delete("access-key")
  async deleteAccessKey(@Req() req: Request) {
    const scope = this.getScope(req);
    requireOperator(scope);
    await this.authService.deleteAccessKey(scope);
    return { ok: true };
  }

  // ── Postman Templates ─────────────────────────────────────────────────────

  @Get("postman-templates")
  async listPostmanTemplates(
    @Req() req: Request,
    @Query("agentId") agentId?: string,
    @Query("page") pageRaw?: string,
    @Query("limit") limitRaw?: string,
    @Query("offset") offsetRaw?: string,
    @Query("search") searchRaw?: string,
  ) {
    const scope = this.getScope(req);
    const prisma = this.prisma;
    if (!prisma) throw new ServiceUnavailableException("Postman templates unavailable");
    const request = parsePageRequest({ page: pageRaw, limit: limitRaw, offset: offsetRaw, search: searchRaw });
    const where = {
      ...environmentScopeWhere(scope),
      ...(agentId ? { agentId } : {}),
      ...(request.search
        ? {
            OR: [
              { name: { contains: request.search, mode: "insensitive" as const } },
              { simulateUserId: { contains: request.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };
    const [templates, total] = await Promise.all([
      prisma.postmanTemplate.findMany({
        where,
        orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
        select: { id: true, agentId: true, name: true, simulateUserId: true, sessionContext: true, isDefault: true, createdAt: true, updatedAt: true },
        take: request.pageSize,
        skip: request.offset,
      }),
      prisma.postmanTemplate.count({ where }),
    ]);
    return {
      templates,
      items: templates,
      total,
      limit: request.pageSize,
      offset: request.offset,
      hasMore: request.offset + templates.length < total,
      pagination: pageMetadata(total, request),
      filters: { agentId: agentId ?? null, search: request.search },
    };
  }

  @Post("postman-templates")
  async createPostmanTemplate(
    @Req() req: Request,
    @Body() body: { agentId: string; name: string; simulateUserId: string; sessionContext?: unknown; isDefault?: boolean },
  ) {
    const scope = this.getScope(req);
    const prisma = this.prisma;
    if (!prisma) throw new ServiceUnavailableException("Postman templates unavailable");
    const binding = await prisma.agentBinding.findFirst({
      where: {
        environmentId: scope.environmentId,
        agentId: body.agentId,
        agent: {
          projectId: scope.projectId,
          project: { organizationId: scope.organizationId },
        },
      },
      select: { id: true },
    });
    if (!binding) throw new NotFoundException("Agent not found in scope");
    if (body.isDefault) {
      await prisma.postmanTemplate.updateMany({
        where: { ...environmentScopeWhere(scope), agentId: body.agentId },
        data: { isDefault: false },
      });
    }
    const template = await prisma.postmanTemplate.create({
      data: {
        environmentId: scope.environmentId,
        agentId: body.agentId,
        name: body.name,
        simulateUserId: body.simulateUserId,
        sessionContext:
          body.sessionContext === undefined || body.sessionContext === null
            ? Prisma.JsonNull
            : (body.sessionContext as Prisma.InputJsonValue),
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
    const prisma = this.prisma;
    if (!prisma) throw new ServiceUnavailableException("Postman templates unavailable");
    const existing = await prisma.postmanTemplate.findFirst({
      where: { id, ...environmentScopeWhere(scope) },
    });
    if (!existing) throw new NotFoundException("Template not found");
    if (body.isDefault) {
      await prisma.postmanTemplate.updateMany({
        where: { ...environmentScopeWhere(scope), agentId: existing.agentId },
        data: { isDefault: false },
      });
    }
    const updated = await prisma.postmanTemplate.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.simulateUserId !== undefined ? { simulateUserId: body.simulateUserId } : {}),
        ...(body.sessionContext !== undefined
          ? {
              sessionContext:
                body.sessionContext === null
                  ? Prisma.JsonNull
                  : (body.sessionContext as Prisma.InputJsonValue),
            }
          : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
      },
    });
    return { template: updated };
  }

  @Delete("postman-templates/:id")
  async deletePostmanTemplate(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    const prisma = this.prisma;
    if (!prisma) throw new ServiceUnavailableException("Postman templates unavailable");
    await prisma.postmanTemplate.deleteMany({
      where: { id, ...environmentScopeWhere(scope) },
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
      throw new BadRequestException(err?.message || "create failed");
    }
  }

  @Get("clusters")
  async listClusters(
    @Req() req: Request,
    @Query("page") pageRaw?: string,
    @Query("limit") limitRaw?: string,
    @Query("offset") offsetRaw?: string,
    @Query("search") searchRaw?: string,
  ) {
    const scope = this.getScope(req);
    const request = parsePageRequest({ page: pageRaw, limit: limitRaw, offset: offsetRaw, search: searchRaw });
    const result = await this.clusterService.listPage(scope, {
      limit: request.pageSize,
      offset: request.offset,
      search: request.search,
    });
    return {
      clusters: result.items,
      items: result.items,
      total: result.total,
      limit: request.pageSize,
      offset: request.offset,
      hasMore: request.offset + result.items.length < result.total,
      pagination: pageMetadata(result.total, request),
      filters: { search: request.search },
    };
  }

  @Get("clusters/:clusterId")
  async getCluster(@Req() req: Request, @Param("clusterId") clusterId: string) {
    const scope = this.getScope(req);
    const cluster = await this.clusterService.get(clusterId, scope);
    if (!cluster) throw new NotFoundException("Cluster not found");
    return { cluster };
  }

  @Patch("clusters/:clusterId")
  async updateCluster(@Req() req: Request, @Param("clusterId") clusterId: string, @Body() body: { name?: string; slug?: string; description?: string; primaryAgentId?: string }) {
    const scope = this.getScope(req);
    try {
      const cluster = await this.clusterService.update(clusterId, scope, body);
      return { cluster };
    } catch (err: any) {
      throw new BadRequestException(err?.message || "update failed");
    }
  }

  @Delete("clusters/:clusterId")
  async deleteCluster(@Req() req: Request, @Param("clusterId") clusterId: string) {
    const scope = this.getScope(req);
    try {
      await this.clusterService.delete(clusterId, scope);
      return { ok: true };
    } catch (err: any) {
      throw new BadRequestException(err?.message || "delete failed");
    }
  }

  @Post("clusters/:clusterId/agents")
  async addAgentToCluster(@Req() req: Request, @Param("clusterId") clusterId: string, @Body() body: { agentId: string; role?: string }) {
    const scope = this.getScope(req);
    try {
      await this.clusterService.addAgent(clusterId, body.agentId, scope, body.role);
      return { ok: true };
    } catch (err: any) {
      throw new BadRequestException(err?.message || "add failed");
    }
  }

  @Delete("clusters/:clusterId/agents/:agentId")
  async removeAgentFromCluster(@Req() req: Request, @Param("clusterId") clusterId: string, @Param("agentId") agentId: string) {
    const scope = this.getScope(req);
    try {
      await this.clusterService.removeAgent(clusterId, agentId, scope);
      return { ok: true };
    } catch (err: any) {
      throw new BadRequestException(err?.message || "remove failed");
    }
  }
}
