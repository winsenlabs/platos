import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { Inject, OnModuleInit, Optional } from "@nestjs/common";
import IORedis from "ioredis";
import { AgentTaskService } from "../agent-runtime/agent-task.service";
import { AuthService } from "../auth/auth.service";
import { REDIS_TOKEN } from "../shared/redis.provider";
import { PRISMA_TOKEN } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";
import { ModuleRef } from "@nestjs/core";
import type { RunsBridgeService } from "../trigger-bridge/runs-bridge.service";
import { MonitoringApprovalsService } from "../monitoring/approvals.service";
import { approvalRedisKey } from "../monitoring/approval-keys";
import { RateLimitService } from "../monitoring/rate-limit.service";
import { SafetyEventService } from "../monitoring/safety-event.service";

/**
 * WebSocket gateway for real-time agent communication.
 *
 * Clients connect, authenticate (session token or 4 scope headers),
 * join rooms, and exchange messages with agents. Token streaming flows
 * through here.
 *
 * Rooms:
 *   scope:{org}:{project}:{env}   — all connections from a scope
 *   thread:{threadId}             — all connections watching a specific thread
 */
/**
 * EOBD.11 — resolve Socket.IO CORS the same way as HTTP (apps/agent/
 * src/main.ts). Production refuses `*` + credentials; dev falls back
 * to `*` + credentials OFF.
 */
function resolveGatewayCors(): { origin: string | string[] | boolean; credentials: boolean } {
  // TODO(env.ts) consider migration — this runs at @WebSocketGateway decorator
  // time, BEFORE main.ts's validateAgentEnv() runs, so going through the lazy
  // `env` proxy here would trigger strict parse before the bootstrap handler
  // can surface structured errors. Keep process.env direct for now.
  const raw = (process.env.PLATOS_CORS_ORIGIN || "").trim();
  if (process.env.NODE_ENV === "production") {
    if (!raw || raw === "*") {
      throw new Error(
        "PLATOS_CORS_ORIGIN is required in production and must not be `*` (Socket.IO gateway). " +
          "Supply a comma-separated list of explicit origins.",
      );
    }
    return {
      origin: raw.split(",").map((s) => s.trim()).filter(Boolean),
      credentials: true,
    };
  }
  if (!raw || raw === "*") return { origin: "*", credentials: false };
  return {
    origin: raw.split(",").map((s) => s.trim()).filter(Boolean),
    credentials: true,
  };
}

/**
 * PRELAUNCH-A3-9 — narrow helper used by the rate-limit gate to attach
 * `replyToMessageId` to error/done frames so the frontend routes them
 * to the thread panel instead of the main conversation.
 */
function threadSuffixForGate(replyToMessageId?: string): Record<string, unknown> {
  return replyToMessageId ? { replyToMessageId } : {};
}

@WebSocketGateway({
  cors: resolveGatewayCors(),
  namespace: "/agent",
  pingInterval: 25000,
  pingTimeout: 10000,
})
export class ConnectionsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit {
  @WebSocketServer()
  server!: Server;

  // Track active AbortControllers per thread for stop generation
  private activeStreams = new Map<string, AbortController>();

  // Dedicated Redis subscriber for approval events (pub/sub requires a separate
  // connection — can't share a pub+sub client with normal commands).
  private approvalSubscriber?: IORedis;

  constructor(
    private readonly agentTaskService: AgentTaskService,
    private readonly authService: AuthService,
    @Inject(REDIS_TOKEN) private readonly redis: IORedis,
    // Phase 1 review follow-up — Prisma is needed on the gateway so
    // `join_thread` can scope-gate the thread lookup. DatabaseModule is
    // `@Global()`, so PRISMA_TOKEN resolves without changing module imports.
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    // REFACTOR — lazy RunsBridge lookup for the durable executionMode dispatch
    // (avoids the RunsBridge↔gateway constructor cycle; same pattern as
    // AgentService.getRunsBridge).
    private readonly moduleRef: ModuleRef,
    @Optional() private readonly approvalsService?: MonitoringApprovalsService,
    /**
     * PRELAUNCH-A3-9 — RateLimitService for the WS message handler. Without
     * this, org-wide minute/day caps were unenforced for WebSocket traffic
     * (RateLimitGuard is HTTP-only). Optional so the test gateway harness
     * keeps booting.
     */
    @Optional() private readonly rateLimitService?: RateLimitService,
    /**
     * PRELAUNCH-A3-4 — record rate-limit denials on the safety-event
     * ledger so governance timelines reflect WS-path blocks too.
     */
    @Optional() private readonly safetyEventService?: SafetyEventService,
  ) {}

  private scopeRoom(scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">): string {
    return `scope:${scope.organizationId}:${scope.projectId}:${scope.environmentId}`;
  }

  async onModuleInit() {
    // Spawn a dedicated subscriber cloning the main redis connection config.
    // Listens for approval:event + thread:lifecycle messages and forwards
    // them to the relevant rooms.
    try {
      this.approvalSubscriber = (this.redis as any).duplicate();
      if (!this.approvalSubscriber) return;
      await this.approvalSubscriber.subscribe("approval:event", "thread:lifecycle", "overview:event");
      this.approvalSubscriber.on("message", (channel, message) => {
        try {
          const payload = JSON.parse(message);
          if (channel === "approval:event") {
            const room = `scope:${payload.organizationId}:${payload.projectId}:${payload.environmentId}`;
            // Single channel carries both the request and the resolution so
            // every subscribed tab can drive its modal state from one stream.
            if (payload.type === "approval_resolved") {
              this.server?.to(room).emit("agent_event", {
                type: "approval_resolved",
                approvalId: payload.approvalId,
                status: payload.status,
                respondedBy: payload.respondedBy,
                agentId: payload.agentId,
              });
            } else {
              this.server?.to(room).emit("agent_event", {
                type: "approval_needed",
                approvalId: payload.approvalId,
                action: payload.action,
                details: payload.details,
                agentId: payload.agentId,
                requestedBy: payload.userId,
              });
            }
          } else if (channel === "thread:lifecycle") {
            // PIFSP-20: broadcast lifecycle events to the scope room AND the
            // thread room so open Conversations tabs update without reloading.
            const scopeRoom = `scope:${payload.organizationId}:${payload.projectId}:${payload.environmentId}`;
            const threadRoom = `thread:${payload.threadId}`;
            this.server?.to(scopeRoom).to(threadRoom).emit("thread_event", payload);
          } else if (channel === "overview:event") {
            // PIFSP-2 — Plato Central live refresh. Published by agent-task.service
            // et al; forwarded to the scope room so any open overview pages update.
            this.server?.to(payload.room).emit(payload.event, payload.data ?? {});
          }
        } catch (err) {
          console.warn("[Platos WS] bad pub/sub event:", err);
        }
      });
      console.log("[Platos WS] approval + lifecycle + overview subscriber ready");
    } catch (err: any) {
      console.warn("[Platos WS] approval subscriber init failed:", err?.message);
    }
  }

  /**
   * On connect: validate session token, extract scope, join rooms.
   */
  async handleConnection(client: Socket) {
    try {
      const auth = (client.handshake.auth || {}) as Record<string, unknown>;
      const headers = client.handshake.headers;

      const token = (auth.token as string | undefined) || (headers["x-platos-session-token"] as string | undefined);

      // External origin? Caddy / any reverse proxy stamps X-Forwarded-For on
      // every proxied request. Internal webapp→agent traffic on the Docker
      // network never passes through a proxy and never has this header, so
      // raw direct-header auth is safe for that service-to-service path
      // only. Mirrors ScopeGuard's HTTP check (apps/agent/src/auth/scope.guard.ts:81)
      // — SPEC §10.3 invariant must hold across all transports.
      const viaProxy = !!headers["x-forwarded-for"];

      let organizationId: string | undefined;
      let projectId: string | undefined;
      let environmentId: string | undefined;
      let userId: string | undefined;
      let entityId: string | undefined;
      let userToken: string | undefined;

      if (token) {
        // Mode 2 session-token JWT — verified HMAC against entity's serviceSecret.
        const payload = await this.authService.validateSessionToken(String(token));
        if (!payload) {
          client.emit("error", { message: "Invalid or expired session token." });
          client.disconnect();
          return;
        }
        organizationId = payload.organizationId;
        projectId = payload.projectId;
        environmentId = payload.environmentId;
        userId = payload.userId;
        entityId = payload.entityId;
        userToken = payload.userToken;
        // Lift the JWT's userMeta into the WS auth bag so the gateway can
        // forward it as scope.sessionContext.user.* on every turn — same
        // path ScopeGuard takes for HTTP. Without this, the streaming path
        // saw only the hashed lead-id and {{user.name}} / {{user.email}}
        // template substitutions stayed empty.
        if (payload.userMeta && (payload.userMeta.name || payload.userMeta.email)) {
          (auth as Record<string, unknown>).userMeta = payload.userMeta;
        }
      } else if (!viaProxy) {
        // Mode 1 direct headers — only when request did NOT come through a proxy.
        organizationId = (auth.organizationId as string | undefined) || (headers["x-platos-organization-id"] as string | undefined);
        projectId = (auth.projectId as string | undefined) || (headers["x-platos-project-id"] as string | undefined);
        environmentId = (auth.environmentId as string | undefined) || (headers["x-platos-environment-id"] as string | undefined);
        userId = (auth.userId as string | undefined) || (headers["x-platos-user-id"] as string | undefined);
        entityId = (auth.entityId as string | undefined) || (headers["x-platos-entity-id"] as string | undefined);
        userToken = (auth.userToken as string | undefined) || (headers["x-platos-user-token"] as string | undefined);
      } else {
        // External request (via Caddy) without a session token — reject.
        client.emit("error", {
          message:
            "External WS connections must provide a session token. Raw scope headers are rejected when the request arrives through the public proxy.",
        });
        client.disconnect();
        return;
      }

      if (!organizationId || !projectId || !environmentId || !userId) {
        client.emit("error", {
          message:
            "Missing auth — need organizationId, projectId, environmentId, userId (or a valid session token).",
        });
        client.disconnect();
        return;
      }

      // Stash on the socket so downstream handlers can forward userToken to tool calls.
      (client as any).platosScope = { organizationId, projectId, environmentId, userId, entityId, userToken };

      const userMeta = (auth as Record<string, unknown>).userMeta as
        | { name?: string; email?: string }
        | undefined;
      const scope: RequestScope = {
        organizationId: String(organizationId),
        projectId: String(projectId),
        environmentId: String(environmentId),
        userId: String(userId),
        // PPR-17: include entityId + userToken so downstream tool calls from
        // WS-initiated turns carry the user-token passthrough (SPEC §4.4 / §10.4).
        // Previously these lived only on `platosScope` and tool calls lost the
        // claim.
        ...(entityId ? { entityId: String(entityId) } : {}),
        ...(userToken ? { userToken: String(userToken) } : {}),
        // Lift JWT userMeta into sessionContext.user.* so the dynamic-block
        // resolver (and span columns) see {{user.name}} / {{user.email}}
        // on every WS turn. ScopeGuard does this for HTTP; we mirror it
        // here for the streaming path.
        ...(userMeta && (userMeta.name || userMeta.email)
          ? {
              sessionContext: {
                user: {
                  ...(userMeta.name ? { name: userMeta.name } : {}),
                  ...(userMeta.email ? { email: userMeta.email } : {}),
                },
              },
            }
          : {}),
      };
      (client as any).scope = scope;

      await client.join(this.scopeRoom(scope));

      // PIFSP-1 — emit deprecation notice on the shared /agent namespace.
      // Per-agent Socket.IO namespace (/agent/:agentId) is the forward path.
      // The shared namespace will be removed in a follow-up ticket (PIFSP-1.1).
      const nsName = (client as any).nsp?.name as string | undefined;
      if (nsName === "/agent") {
        client.emit("server.deprecation", {
          code: "SHARED_AGENT_NAMESPACE",
          message: "Connecting to /agent is deprecated. Use /agent/{agentId} for per-agent Socket.IO.",
          removeAfter: "2026-07-01",
        });
      }

      client.emit("connected", {
        status: "ok",
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: scope.userId,
        socketId: client.id,
      });

      console.log(
        `[Platos WS] Connected: ${client.id} org=${scope.organizationId} project=${scope.projectId} env=${scope.environmentId} user=${scope.userId}`,
      );
    } catch (error) {
      console.error(`[Platos WS] Connection error:`, error);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const scope = (client as any).scope as RequestScope | undefined;
    console.log(
      `[Platos WS] Disconnected: ${client.id} org=${scope?.organizationId || "unknown"} project=${scope?.projectId || "unknown"} env=${scope?.environmentId || "unknown"}`,
    );
  }

  /**
   * Send a message to an agent and stream the response back.
   */
  @SubscribeMessage("message")
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      message: string;
      threadId?: string;
      agentId?: string;
      contextType?: string;
      contextId?: string;
      dynamicBlocks?: Record<string, string>;
      attachmentIds?: string[];
      /** PIFSP-9 Postman mode — override sessionContext for this turn only. */
      sessionContextOverride?: Record<string, unknown>;
      /** PIFSP-9 Postman mode — simulate a different userId within the same scope. */
      postmanUserId?: string;
      /** Per-request model routing label. Selects from agentConfig.modelRoutes. */
      modelLabel?: string;
      /** PRA-TC: sub-thread reply. When set, this turn is a reply inside a sub-thread. */
      replyToMessageId?: string;
    },
  ) {
    const scope = (client as any).scope as RequestScope;
    if (!scope) {
      client.emit("error", { message: "Not authenticated" });
      return;
    }

    // Resolve agentId. Priority:
    //   1. data.agentId — if the client explicitly sent one.
    //   2. The thread's stored agentId — when data.threadId is set but
    //      data.agentId is not (the common case for SDK consumers calling
    //      `client.threads.send(threadId, msg)` — the SDK doesn't include
    //      agentId in subsequent sends because the thread already has it).
    //   3. Literal "default" — last-resort fallback.
    //
    // Pre-fix: only (1) and (3). When the SDK sent a follow-up message
    // through this gateway with no agentId in the body, the runtime
    // resolved to "default", loaded a generic "You are a helpful AI
    // assistant" config, and ignored the thread's actual agent. Symptom:
    // the marketing widget's chat answered in a generic Claude voice
    // instead of the configured prompt — same agentId, same scope,
    // different code path than the dashboard chat (which always passes
    // agentId on each turn).
    let agentId = data.agentId;
    if (!agentId && data.threadId) {
      try {
        const threadRow = await this.prisma.platosAgentThread.findFirst({
          where: { id: data.threadId },
          select: { agentId: true },
        });
        if (threadRow?.agentId) agentId = threadRow.agentId;
      } catch (err: any) {
        console.warn(
          `[connections.gateway] thread→agentId lookup failed for ${data.threadId}: ${err?.message ?? err}`,
        );
      }
    }
    if (!agentId) agentId = "default";

    // Do NOT auto-generate threadId here — executeStreamingTurn handles thread
    // creation via getOrCreateThread and emits the resulting thread_id in the
    // meta event. Frontend must capture that and pass it in subsequent messages.
    let resolvedThreadId = data.threadId;

    // EOBD.26 — wire an AbortController through the turn so the `stop`
    // event handler below can actually terminate the LLM stream. Pre-EOBD
    // activeStreams was declared but never populated; `stop` was a no-op
    // that made the UI show "done" while the LLM kept streaming + billing.
    // PRA-TC: capture replyToMessageId before try so catch/finally can propagate it.
    const replyToMessageId = data.replyToMessageId;
    // MINOR-1: include replyToMessageId in the stream key so main + thread streams
    // on the same threadId don't overwrite each other's AbortController.
    const ac = new AbortController();
    const ackey = (tid: string | undefined) =>
      `${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${tid ?? "unknown"}:${replyToMessageId ?? "main"}`;
    if (resolvedThreadId) {
      this.activeStreams.set(ackey(resolvedThreadId), ac);
    }

    try {
      // BUG-11 (revised): gate postmanUserId on the caller being an org admin.
      // Original BUG-11 fix used the system PLATOS_ADMIN_TOKEN, but that's only
      // available to infra operators — broke the legitimate Postman mode flow
      // where org admins simulate user IDs while testing their own agents.
      // Now we check OrgMember.role within scope.organizationId.
      let isOrgAdmin = false;
      try {
        const orgMember = await this.prisma.orgMember.findFirst({
          where: {
            userId: scope.userId,
            organizationId: scope.organizationId,
          },
          select: { role: true },
        });
        isOrgAdmin = orgMember?.role === "ADMIN";
      } catch {
        // Defensive: if the role lookup blows up, fall through to no-op
        // (effectiveUserId stays as scope.userId — preserves BUG-11 guarantee).
        isOrgAdmin = false;
      }
      // PIFSP-9 Postman mode: only allow simulating a different userId when
      // the caller is an ADMIN of scope.organizationId.
      const effectiveUserId = (isOrgAdmin && data.postmanUserId && data.postmanUserId !== scope.userId)
        ? data.postmanUserId
        : scope.userId;
      // LAUNCH-12 — preserve the real operator's userId so createThread can
      // stamp it on the row even when `userId` gets overridden to the
      // simulated one. Allows the operator to see their own threads in the
      // conversations list regardless of Postman state.
      const isPostmanOverride = effectiveUserId !== scope.userId;
      const scopeWithAgent: RequestScope = {
        ...scope,
        agentId,
        userId: effectiveUserId,
        ...(isPostmanOverride ? { operatorUserId: scope.userId } : {}),
        // Pre-populate sessionContext so stream() skips the DB lookup and
        // uses the Postman override directly. Merge with the JWT-lifted
        // sessionContext (carrying user.name / user.email from userMeta)
        // so a Postman override doesn't wipe visitor identity for the
        // dynamic-block resolver.
        ...(data.sessionContextOverride
          ? {
              sessionContext: {
                ...(scope.sessionContext as Record<string, unknown> | undefined),
                ...data.sessionContextOverride,
              },
            }
          : {}),
      };

      // PRELAUNCH-A3-9 — org-wide minute/day rate-limit check. The HTTP
      // RateLimitGuard doesn't run on Socket.IO message handlers, so
      // WebSocket traffic was previously unbounded for org caps. Enforce
      // here before kicking off the streaming turn.
      if (this.rateLimitService) {
        try {
          const rl = await this.rateLimitService.checkOrgRequest({
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          });
          if (!rl.allowed) {
            // PRELAUNCH-A3-4 — record the denial.
            this.safetyEventService
              ?.record(
                {
                  organizationId: scope.organizationId,
                  projectId: scope.projectId,
                  environmentId: scope.environmentId,
                },
                {
                  detector: "rate_limit",
                  action: "block",
                  severity: "medium",
                  detail: `${rl.bucket} exceeded (${rl.count}/${rl.limit}) [WS]`,
                  meta: { bucket: rl.bucket, limit: rl.limit, transport: "websocket" },
                  agentId,
                  userId: scope.userId,
                },
              )
              .catch(() => undefined);
            client.emit("error", {
              code: "rate_limit",
              message: `Rate limit reached. Try again in ${rl.retryAfterSeconds} seconds.`,
              retryAfterSeconds: rl.retryAfterSeconds,
              scope: rl.bucket,
              limit: rl.limit,
              ...threadSuffixForGate(replyToMessageId),
            });
            client.emit("done", { stopped: true, ...threadSuffixForGate(replyToMessageId) });
            return;
          }
        } catch {
          // Fail-open on any rate-limit backend error.
        }
      }

      // PRA-TC: thread events suffix — ensures every event emitted for a
      // sub-thread turn carries replyToMessageId so the frontend can route them
      // to the thread panel (not the main timeline), including done/error.
      const threadSuffix = replyToMessageId ? { replyToMessageId } : {};

      // REFACTOR (Trigger Sessions — Option 1) — durable chat via a Trigger
      // SESSION (platos.chat.session worker + Platos proxy-bridge). Flag-gated
      // rollout: PLATOS_CHAT_SESSIONS=true routes durable agents through the
      // session path; otherwise the older durable-turn task path below runs.
      // Phase 6 (cutover) flips the flag on and deletes the old path.
      if (await this.tryDispatchSession(data, scopeWithAgent, agentId, replyToMessageId, client)) {
        return;
      }

      // REFACTOR (control-plane + trigger substrate) — durable executionMode.
      // If the agent is executionMode="durable" AND managed trigger is
      // configured, hand the turn to the platos.agent.durable-turn task and
      // bridge its run to the thread room instead of running in-process.
      // Dormant + zero-regression until managed trigger keys exist (falls back
      // to the direct in-process path below when trigger is unconfigured or no
      // threadId is present).
      if (await this.tryDispatchDurable(data, scopeWithAgent, agentId, replyToMessageId, client)) {
        return;
      }

      for await (const event of this.agentTaskService.executeStreamingTurn(
        data.message,
        scopeWithAgent,
        {
          threadId: data.threadId,
          agentId,
          contextType: data.contextType,
          contextId: data.contextId,
          dynamicBlocks: data.dynamicBlocks,
          attachmentIds: data.attachmentIds,
          abortSignal: ac.signal,
          // EOBD.28 — accept idempotency key from the WS message so
          // rapid retries (client reconnect) don't duplicate turns.
          idempotencyKey: (data as any).idempotencyKey as string | undefined,
          // Per-request model routing label forwarded from the client.
          modelLabel: data.modelLabel,
          // PRA-TC: sub-thread reply forwarded from client.
          replyToMessageId,
        },
      )) {
        if (event.type === "meta" && (event as any).thread_id) {
          resolvedThreadId = (event as any).thread_id as string;
          // Re-key activeStreams once executeStreamingTurn resolves the
          // real thread id — handles the thread-auto-create path.
          this.activeStreams.set(ackey(resolvedThreadId), ac);
          await client.join(`thread:${resolvedThreadId}`);
        }
        client.emit("agent_event", { ...event, threadId: resolvedThreadId, ...threadSuffix });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const aborted = ac.signal.aborted;
      client.emit("agent_event", {
        type: "error",
        message,
        code: aborted ? "aborted" : undefined,
        threadId: resolvedThreadId,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      });
      client.emit("agent_event", { type: "done", threadId: resolvedThreadId, aborted, ...(replyToMessageId ? { replyToMessageId } : {}) });
    } finally {
      if (resolvedThreadId) this.activeStreams.delete(ackey(resolvedThreadId));
    }
  }

  // REFACTOR — lazy RunsBridge resolver (mirrors AgentService.getRunsBridge).
  // Deferred require so the CJS RunsBridge↔gateway cycle is settled first.
  private cachedRunsBridge: RunsBridgeService | null = null;
  private getRunsBridge(): RunsBridgeService | null {
    if (this.cachedRunsBridge) return this.cachedRunsBridge;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RunsBridgeService: Svc } = require("../trigger-bridge/runs-bridge.service");
      this.cachedRunsBridge = this.moduleRef.get(Svc, { strict: false });
      return this.cachedRunsBridge;
    } catch {
      return null;
    }
  }

  /**
   * REFACTOR (control-plane + trigger substrate) — durable executionMode
   * dispatch. Returns true if the turn was handed to the
   * `platos.agent.durable-turn` trigger task (and its run bridged to the
   * thread room); false to fall back to the in-process (direct) path.
   *
   * Dormant unless ALL hold: agent.executionMode==="durable" and
   * TRIGGER_SECRET_KEY set (managed trigger configured). So on a deployment
   * without managed trigger every turn stays direct — zero behaviour change
   * until the substrate exists.
   *
   * New-thread turns are supported: when the client sends no threadId (a fresh
   * conversation, e.g. the demo chat's first message), we mint the thread
   * up-front so the client can be joined to its room before the async run
   * starts streaming, and so message #1 runs durably too. (Previously the first
   * message of every durable conversation silently fell back to the direct
   * path — the agent looked like it "wasn't using trigger" until the 2nd turn.)
   */
  /**
   * REFACTOR (Trigger Sessions — Option 1, Platos proxies) — durable chat via
   * a Trigger SESSION. The `platos.chat.session` `chat.customAgent` worker owns
   * the durable session; each turn calls back into this agent's
   * `/internal/chat/stream-turn` (so the EXISTING executeStreamingTurn does
   * config/keys/tools/memory/cost/persistence), and the reply lands in the
   * session's durable `.out`. This method is the PROXY-BRIDGE: it drives the
   * session server-side via `AgentChat` and forwards stream parts to the
   * thread room as the client's existing `agent_event` frames — the browser
   * never talks to Trigger (3rd parties only ever touch Platos), and there is
   * exactly ONE emit per event (no scope/thread double-emit).
   *
   * Wins over the durable-turn path it replaces: the turn completes even if
   * the CLIENT disconnects mid-stream (worker keeps consuming; result persists
   * + is resumable from `.out`), replies are re-readable after gateway
   * restarts, and the relay is one ordered stream instead of ad-hoc
   * multi-room emits. (Agent-process restarts still abort the in-flight
   * generation — inherent to reusing the in-agent loop; accepted trade.)
   *
   * Flag-gated: PLATOS_CHAT_SESSIONS=true + executionMode="durable" +
   * TRIGGER_SECRET_KEY. Returns false to fall through to older paths.
   */
  private async tryDispatchSession(
    data: any,
    scope: RequestScope,
    agentId: string,
    replyToMessageId: string | undefined,
    client: Socket,
  ): Promise<boolean> {
    if (process.env.PLATOS_CHAT_SESSIONS !== "true") return false;
    if (!process.env.TRIGGER_SECRET_KEY) return false;
    // Sub-thread replies keep the existing paths (session wire has no
    // replyToMessageId concept yet).
    if (replyToMessageId) return false;

    let executionMode = "direct";
    try {
      const agent = await this.prisma.platosAgent.findFirst({
        where: {
          id: agentId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        select: { executionMode: true },
      });
      executionMode = agent?.executionMode ?? "direct";
    } catch {
      return false;
    }
    if (executionMode !== "durable") return false;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chatSdk = (() => {
      try {
        return require("@trigger.dev/sdk/chat");
      } catch {
        return null;
      }
    })();
    if (!chatSdk?.AgentChat) return false;

    // Mint the thread up-front for new conversations (same as the durable
    // path) — the session externalId IS the threadId, so it must exist first.
    let threadId = data?.threadId as string | undefined;
    if (!threadId) {
      try {
        const convo = (this.agentTaskService as any).conversationService;
        const created = await convo?.getOrCreateThread?.(scope, agentId);
        threadId = created?.id as string | undefined;
      } catch {
        return false;
      }
      if (!threadId) return false;
    }

    try {
      const chatClient = new chatSdk.AgentChat({
        agent: "platos.chat.session",
        id: threadId,
        clientData: {
          agentId,
          threadId,
          scope: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            userId: scope.userId,
          },
        },
      });

      const room = `thread:${threadId}`;
      await client.join(room);
      client.emit("agent_event", {
        type: "meta",
        thread_id: threadId,
        threadId,
        durable: true,
        session: true,
      });

      const stream = await chatClient.sendMessage(data.message);

      // Forward the durable .out stream to the room. Deliberately not awaited:
      // the WS handler returns while the bridge pumps. One emit per event.
      void (async () => {
        try {
          for await (const part of stream as AsyncIterable<any>) {
            let evt: Record<string, unknown> | null = null;
            if (part?.type === "text-delta") {
              evt = { type: "token", text: part.delta ?? "" };
            } else if (part?.type === "data-platos-event") {
              evt = part.data as Record<string, unknown>;
            } else if (part?.type === "error") {
              evt = { type: "error", message: part.errorText ?? "turn failed" };
            }
            if (evt) {
              this.server?.to(room).emit("agent_event", { ...evt, threadId });
            }
          }
          this.server?.to(room).emit("agent_event", { type: "done", threadId });
        } catch (err: any) {
          this.server?.to(room).emit("agent_event", {
            type: "error",
            message: err?.message ?? String(err),
            threadId,
          });
          this.server?.to(room).emit("agent_event", { type: "done", threadId });
        }
      })();

      return true;
    } catch {
      // Session dispatch failed — fall through to durable-turn / direct.
      return false;
    }
  }

  private async tryDispatchDurable(
    data: any,
    scope: RequestScope,
    agentId: string,
    replyToMessageId: string | undefined,
    client: Socket,
  ): Promise<boolean> {
    let threadId = data?.threadId as string | undefined;

    let executionMode = "direct";
    try {
      const agent = await this.prisma.platosAgent.findFirst({
        where: {
          id: agentId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        select: { executionMode: true },
      });
      executionMode = agent?.executionMode ?? "direct";
    } catch {
      return false;
    }
    if (executionMode !== "durable") return false;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const triggerSdk = (() => {
      try {
        return require("@trigger.dev/sdk");
      } catch {
        return null;
      }
    })();
    const triggerReady = !!process.env.TRIGGER_SECRET_KEY && !!triggerSdk?.tasks?.trigger;
    if (!triggerReady) return false; // managed trigger not configured → direct

    // New-thread durable turn: no threadId from the client (fresh chat). Mint
    // the thread now so (a) we hand a concrete threadId to the run, (b) we can
    // join the client to its room before the run streams, and (c) the client
    // adopts it for subsequent turns via the meta event below. On failure, fall
    // back to the direct path (which mints the thread itself).
    if (!threadId) {
      try {
        const convo = (this.agentTaskService as any).conversationService;
        const created = await convo?.getOrCreateThread?.(scope, agentId);
        threadId = created?.id as string | undefined;
      } catch {
        return false;
      }
      if (!threadId) return false;
    }

    try {
      const clientMessageId = (data as any).idempotencyKey as string | undefined;
      const handle = await triggerSdk.tasks.trigger(
        "platos.agent.durable-turn",
        {
          threadId,
          agentId,
          message: data.message,
          replyToMessageId: replyToMessageId ?? null,
          clientMessageId: clientMessageId ?? null,
          scope: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            userId: scope.userId,
            agentId,
            threadId,
          },
        },
        {
          // Model A per-tenant fairness — one shared trigger project, isolated
          // by org-scoped concurrency key.
          concurrencyKey: `org-${scope.organizationId}`,
          ...(clientMessageId ? { idempotencyKey: `turn-${threadId}-${clientMessageId}` } : {}),
          tags: [
            `org:${scope.organizationId}`,
            `project:${scope.projectId}`,
            `env:${scope.environmentId}`,
            `thread:${threadId}`,
          ],
        },
      );
      const runId = handle?.id as string | undefined;
      await client.join(`thread:${threadId}`);
      // Bridge the durable run's realtime events into the thread room (client
      // is joined). RunsBridge no-ops if the SDK realtime isn't available.
      if (runId) this.getRunsBridge()?.subscribe(runId, scope, threadId);
      client.emit("agent_event", {
        type: "meta",
        thread_id: threadId,
        threadId,
        durable: true,
        runId,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      });
      return true;
    } catch {
      // Dispatch failed — fall back to the in-process path.
      return false;
    }
  }

  /**
   * Join a thread room to receive events for an existing conversation.
   *
   * Phase 1 review follow-up — scope-gate the join. Pre-fix any authenticated
   * socket could join any `thread:<id>` room by id (amplified by W.1.2 which
   * emits batch `output` — containing per-item PII — into thread rooms). Now
   * we confirm the thread's `(org, project, env)` matches the socket's
   * bound scope before joining; mismatches are indistinguishable from
   * missing rows (no id-existence oracle).
   */
  @SubscribeMessage("join_thread")
  async handleJoinThread(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { threadId: string },
  ) {
    const scope = (client as any).scope as RequestScope | undefined;
    if (!scope) {
      client.emit("error", { message: "unauthenticated" });
      return;
    }
    if (!data?.threadId || typeof data.threadId !== "string") {
      client.emit("error", { message: "threadId is required" });
      return;
    }
    try {
      const thread = await this.prisma.platosAgentThread.findFirst({
        where: {
          id: data.threadId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        select: { id: true },
      });
      if (!thread) {
        client.emit("error", { message: "thread not found" });
        return;
      }
    } catch (err: any) {
      client.emit("error", { message: "thread lookup failed" });
      console.warn(
        `[Platos WS] join_thread lookup failed threadId=${data.threadId}: ${err?.message}`,
      );
      return;
    }
    await client.join(`thread:${data.threadId}`);
    client.emit("joined_thread", { threadId: data.threadId });
  }

  /**
   * Leave a thread room.
   */
  @SubscribeMessage("leave_thread")
  async handleLeaveThread(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { threadId: string },
  ) {
    // BUG-16: validate threadId is a non-empty string before using it.
    // Socket.IO's leave() is per-socket (can only leave itself), but
    // we still validate to prevent malformed room key injection.
    if (!data?.threadId || typeof data.threadId !== "string") return;
    await client.leave(`thread:${data.threadId}`);
  }

  /**
   * Client responds to an approval request.
   */
  @SubscribeMessage("approval_response")
  async handleApprovalResponse(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { approvalId: string; approved: boolean; comment?: string },
  ) {
    const scope = (client as any).scope as RequestScope | undefined;
    if (!scope) return;
    // EOBD.14 — scope-gate the rpush. Caller in scope A must not be
    // able to wake a scope-B agent blpop by knowing a scope-B
    // approvalId. Verify the approval belongs to this scope first,
    // then rpush to the scoped Redis namespace (EOBD.15).
    const scopeTuple = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
    const found = await this.approvalsService?.getById(scopeTuple, data.approvalId);
    if (!found) {
      client.emit("approval_response_error", {
        approvalId: data.approvalId,
        error: "Approval not found in this scope",
      });
      return;
    }
    const payload = JSON.stringify({
      approved: !!data.approved,
      comment: data.comment,
      respondedBy: scope.userId,
      respondedAt: new Date().toISOString(),
    });
    const redisKey = approvalRedisKey(scopeTuple, data.approvalId);
    await this.redis.rpush(redisKey, payload);
    await this.redis.expire(redisKey, 60);
    // Persist the transition to the governance ledger (Theme E.6). The
    // agent's blpop-wake path also writes; both are idempotent because
    // `resolve` is a no-op on rows already in a terminal status.
    await this.approvalsService?.resolve({
      scope: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      approvalId: data.approvalId,
      status: data.approved ? "approved" : "rejected",
      respondedBy: scope.userId,
      comment: data.comment,
    });
    client.emit("approval_ack", { approvalId: data.approvalId, received: true });
  }

  /**
   * PIFSP-20 — Thread rename via Socket.IO.
   * Client sends: { threadId, title }
   * Server broadcasts: thread_event { type:"thread.renamed", threadId, title, updatedAt }
   * Scope-gated: the thread must belong to the authenticated socket's scope.
   */
  @SubscribeMessage("thread.rename")
  async handleThreadRename(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { threadId: string; title: string | null },
  ) {
    const scope = (client as any).scope as RequestScope | undefined;
    if (!scope) {
      client.emit("error", { message: "unauthenticated" });
      return;
    }
    if (!data?.threadId || typeof data.threadId !== "string") {
      client.emit("error", { message: "threadId required" });
      return;
    }
    try {
      const sanitized =
        data.title === null
          ? null
          : data.title.replace(/[\r\n]/g, " ").trim().slice(0, 200) || null;
      const now = new Date();
      const result = await this.prisma.platosAgentThread.updateMany({
        where: {
          id: data.threadId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          userId: scope.userId,
        },
        data: { title: sanitized, updatedAt: now },
      });
      if (result.count === 0) {
        client.emit("error", { message: "thread not found or access denied" });
        return;
      }
      const event = {
        type: "thread.renamed",
        threadId: data.threadId,
        title: sanitized,
        updatedAt: now.toISOString(),
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      };
      const scopeRoom = this.scopeRoom(scope);
      const threadRoom = `thread:${data.threadId}`;
      this.server?.to(scopeRoom).to(threadRoom).emit("thread_event", event);
    } catch (err: any) {
      client.emit("error", { message: "rename failed" });
    }
  }

  /**
   * Stop generation — abort the current agent stream.
   */
  @SubscribeMessage("stop")
  async handleStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { threadId: string },
  ) {
    // EOBD.26 — activeStreams keyed by `${scope}:${threadId}` so a
    // stop from scope A can't abort scope B's in-flight turn.
    const scope = (client as any).scope as RequestScope | undefined;
    if (!scope) return;
    const key = `${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${data.threadId}`;
    const controller = this.activeStreams.get(key);
    if (controller) {
      controller.abort();
      this.activeStreams.delete(key);
    }
    client.emit("agent_event", { type: "done", threadId: data.threadId, stopped: true });
  }
}
