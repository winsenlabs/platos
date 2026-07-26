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
import { TurnDispatchService } from "../agent-runtime/turn-dispatch.service";
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
    // The durable-vs-direct chokepoint. The gateway sources the dispatch
    // DECISION (executionMode read) from here instead of its two former inline
    // findFirsts, and delegates the durable trigger send to it — keeping only
    // the socket TAIL (room join + RunsBridge subscribe + meta emit) local.
    private readonly dispatch: TurnDispatchService,
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

  /**
   * SECURITY (audit H4) — per-user room. Sensitive per-user events (approvals,
   * run output, thread titles) are delivered here so co-tenants don't receive
   * each other's content. The scope room is now operator-audience only.
   */
  private userRoom(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId" | "userId">,
  ): string {
    return `user:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${scope.userId}`;
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
            // SECURITY (audit H4/H5) — approval_needed carries the tool action +
            // arguments (often PII). Deliver ONLY to the requesting user's room
            // + the operator scope room (operators may action on behalf of a
            // user), NOT the whole tenant. The requesting user is no longer in
            // the scope room (operator-only now), so their user room is
            // required for them to see their own prompt.
            const scopeRoom = `scope:${payload.organizationId}:${payload.projectId}:${payload.environmentId}`;
            const reqUserRoom = payload.userId
              ? `user:${payload.organizationId}:${payload.projectId}:${payload.environmentId}:${payload.userId}`
              : undefined;
            const target = reqUserRoom
              ? this.server?.to(reqUserRoom).to(scopeRoom)
              : this.server?.to(scopeRoom);
            if (payload.type === "approval_resolved") {
              target?.emit("agent_event", {
                type: "approval_resolved",
                approvalId: payload.approvalId,
                status: payload.status,
                respondedBy: payload.respondedBy,
                agentId: payload.agentId,
              });
            } else {
              target?.emit("agent_event", {
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
            // SECURITY (audit H4 regression) — the owner left the scope room
            // (operator-only now), so also target their user room; otherwise
            // their conversation LIST (where they aren't joined to the specific
            // thread room) stops getting live archive/rename updates.
            const scopeRoom = `scope:${payload.organizationId}:${payload.projectId}:${payload.environmentId}`;
            const threadRoom = `thread:${payload.threadId}`;
            const ownerUserRoom = payload.userId
              ? `user:${payload.organizationId}:${payload.projectId}:${payload.environmentId}:${payload.userId}`
              : undefined;
            const lifecycleTarget = ownerUserRoom
              ? this.server?.to(scopeRoom).to(threadRoom).to(ownerUserRoom)
              : this.server?.to(scopeRoom).to(threadRoom);
            lifecycleTarget?.emit("thread_event", payload);
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
      let pinnedAgentId: string | undefined; // SECURITY (H6) — token-pinned agent
      let principal: "operator" | "end-user" = "end-user";
      // Verified-identity claims — populated ONLY from a validated non-guest
      // token below; stays undefined on the direct-header path.
      let userIdentities:
        | Array<{ channel: string; handle: string; verified?: boolean }>
        | undefined;

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
        // SECURITY (audit H6) — capture the token's pinned agentId; a turn must
        // not target a different agent. Operator = platform-signed + non-guest
        // (mirrors ScopeGuard / the HTTP path).
        pinnedAgentId = (payload as any).agentId;
        principal =
          payload.iss === "platos-platform" && (payload as any).isGuest !== true
            ? "operator"
            : "end-user";
        // Carry verified-identity claims for NON-GUEST tokens so WS turns
        // resolve the same canonical PlatosEndUser as the HTTP path. Guest
        // tokens (anonymous visitors, EOBD.89) must never assert an identity —
        // same isGuest gate ScopeGuard uses. Copied verbatim from the
        // validated payload.
        if (
          (payload as any).isGuest !== true &&
          Array.isArray(payload.userIdentities) &&
          payload.userIdentities.length > 0
        ) {
          userIdentities = payload.userIdentities;
        }
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
        // Trusted internal direct-header path (webapp control-plane).
        principal = "operator";
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
        principal,
        ...(pinnedAgentId ? { agentId: String(pinnedAgentId) } : {}),
        // Carry non-guest verified-identity claims so WS-initiated turns
        // resolve the same canonical PlatosEndUser as the HTTP path. Only ever
        // set from a validated non-guest token (see above); never on the
        // direct-header path.
        ...(userIdentities ? { userIdentities } : {}),
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
      (client as any).pinnedAgentId = pinnedAgentId;

      // SECURITY (audit H4) — join a PER-USER room, and the tenant-wide scope
      // room ONLY for operators. Sensitive per-user events (approvals, run
      // output, thread titles) are delivered to the user room; the scope room
      // is now operator-audience only. Previously every client joined the
      // scope room and received every other user's events.
      await client.join(this.userRoom(scope));
      if (scope.principal === "operator") {
        await client.join(this.scopeRoom(scope));
      }

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
        // SECURITY (audit L1) — scope the thread→agentId lookup. Keyed on
        // threadId alone, a caller in org A passing an org-B threadId learned
        // B's agentId (an oracle) and mislabeled the turn onto A's telemetry.
        // org/proj/env are denormalized on PlatosAgentThread. userId is
        // deliberately NOT added: Postman mode overwrites thread.userId with
        // the SIMULATED user, so a userId filter would miss and silently fall
        // back to the "default" agent. The tenant tuple closes the oracle.
        const threadRow = await this.prisma.platosAgentThread.findFirst({
          where: {
            id: data.threadId,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
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

    // SECURITY (audit H6) — enforce the token's pinned agent. Without this, a
    // guest token pinned to public agent A could set data.agentId=B and run a
    // turn against a PRIVATE agent B (its prompt, tools, memory, BYOK keys).
    // Mirrors ScopeGuard's AGENT_SCOPE_MISMATCH on the HTTP path.
    const pinnedAgentId = (client as any).pinnedAgentId as string | undefined;
    if (pinnedAgentId && agentId !== pinnedAgentId) {
      client.emit("error", {
        code: "AGENT_SCOPE_MISMATCH",
        message: `This session is scoped to agent ${pinnedAgentId} but the message targets agent ${agentId}.`,
      });
      return;
    }

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
    // SECURITY (audit H13) — include userId so a co-tenant can't abort another
    // user's turn on a guessed threadId. The prefix
    // `${org}:${proj}:${env}:${userId}:${tid}:` is what handleStop matches.
    const ackey = (tid: string | undefined) =>
      `${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${scope.userId}:${tid ?? "unknown"}:${replyToMessageId ?? "main"}`;
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

      // THE INVARIANT (single chokepoint) — the durable-vs-direct decision is
      // read ONCE here, from TurnDispatchService.resolveMode (the only place
      // executionMode is read for dispatch, across every entry path). The
      // gateway no longer re-reads executionMode inside tryDispatchSession /
      // tryDispatchDurable; both are now attempted ONLY when the mode is
      // "durable". A "direct" agent (or a deployment without managed trigger)
      // falls straight through to the in-process stream below — unchanged.
      const dispatchMode = await this.dispatch.resolveMode(agentId, scopeWithAgent);
      if (dispatchMode === "durable") {
        // Trigger-Sessions SUB-strategy (gateway-resident, socket-coupled): a
        // flag-gated rollout of the durable path via a Trigger SESSION
        // (platos.chat.session worker + Platos proxy-bridge). It is layered on
        // top of the durable decision — not a distinct executionMode — so it
        // stays here. Returns false (fall through) when its own flags/SDK gates
        // aren't met.
        if (await this.tryDispatchSession(data, scopeWithAgent, agentId, replyToMessageId, client)) {
          return;
        }
        // Durable-turn via the chokepoint: dispatch to platos.agent.durable-turn
        // and bridge its run to the thread room (RunsBridge) instead of running
        // in-process. Fail-open: a dispatch failure returns false and falls
        // through to the identical direct in-process path below (never a
        // dropped turn).
        if (await this.tryDispatchDurable(data, scopeWithAgent, agentId, replyToMessageId, client)) {
          return;
        }
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
    // NOTE (chokepoint): executionMode is NOT read here anymore. handleMessage
    // only calls this after TurnDispatchService.resolveMode has already decided
    // "durable" — this method now owns only the SESSION sub-strategy's own gates
    // (rollout flag, trigger secret, no sub-thread replies, chat SDK present).
    if (process.env.PLATOS_CHAT_SESSIONS !== "true") return false;
    if (!process.env.TRIGGER_SECRET_KEY) return false;
    // Sub-thread replies keep the existing paths (session wire has no
    // replyToMessageId concept yet).
    if (replyToMessageId) return false;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chatSdk = (() => {
      try {
        return require("@trigger.dev/sdk/chat");
      } catch {
        return null;
      }
    })();
    if (!chatSdk?.AgentChat) return false;

    // SECURITY (cross-tenant IDOR) — ALWAYS resolve the threadId through
    // getOrCreateThread, which scope+owner-gates it (getThread filters by the
    // full scope tuple AND userId/createdByUserId). Never trust a client-
    // supplied threadId directly: without this, a caller could pass a victim's
    // threadId and get joined to `thread:<victimId>` — reading the victim's
    // streamed turns and injecting into their live UI. A non-owned threadId
    // resolves to a freshly minted (owned) thread instead. The session
    // externalId IS this resolved threadId, so it must exist first anyway.
    let threadId: string | undefined;
    try {
      const convo = (this.agentTaskService as any).conversationService;
      const resolved = await convo?.getOrCreateThread?.(scope, agentId, data?.threadId);
      threadId = resolved?.id as string | undefined;
    } catch {
      return false;
    }
    if (!threadId) return false;

    try {
      // FRESH AgentChat per message (deliberate — do NOT cache): with the
      // one-turn-per-run worker (chat.endRun after each turn), the previous
      // run has fully exited by the next message. A cached instance believes
      // its run is still alive and appends into a dead run's inbox — the
      // message never dispatches (observed live: turn 2 done/0 chars, no
      // continuation run spawned). A fresh instance takes the trigger path:
      // sessions.start is idempotent, the server sees no active run, and
      // spawns a continuation run. Replay of old .out chunks is prevented
      // server-side since 4.5.2 (cursor advance fix); the Redis lastEventId
      // is belt-and-braces when available.
      {
        // SECURITY (audit L4) — scope-namespace the cursor key. Defense in
        // depth against a cuid collision across tenants. NOTE: the same key is
        // rebuilt as a literal on the write side below — both must match.
        const cursorKey = `chatsess:cursor:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${threadId}`;
        let lastEventId: string | undefined;
        try {
          lastEventId = (await this.redis.get(cursorKey)) ?? undefined;
        } catch {
          lastEventId = undefined;
        }

        // RACE GUARD — one-turn-per-run means the previous run spends ~10s
        // finalizing after its last chunk. An append during that window lands
        // in the exiting run's inbox and is never consumed (server only
        // re-triggers when no run is alive). If the user replies within the
        // window, wait for the previous run to fully exit first. No-ops on
        // first messages (no session yet) and costs one retrieve (~100ms)
        // on relaxed-cadence turns.
        if (lastEventId) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { sessions: sessionsSdk, runs: runsSdk } = require("@trigger.dev/sdk");
            const sess = await sessionsSdk.retrieve(threadId!).catch(() => null);
            const prevRunId = (sess as any)?.currentRunId as string | undefined;
            if (prevRunId) {
              for (let i = 0; i < 20; i++) {
                const r: any = await runsSdk.retrieve(prevRunId).catch(() => null);
                if (!r || r.isCompleted || !["EXECUTING", "QUEUED", "DEQUEUED", "WAITING"].includes(String(r.status))) break;
                await new Promise((res) => setTimeout(res, 1000));
              }
            }
          } catch {
            // best-effort; proceed
          }
        }
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
          ...(lastEventId ? { session: { lastEventId } } : {}),
          onTurnComplete: async ({ lastEventId: cursor }: { lastEventId?: string }) => {
            if (cursor) {
              await (this.redis as any)
                .set(cursorKey, cursor, "EX", 60 * 60 * 24 * 30)
                .catch(() => undefined);
            }
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
          // Persist the session cursor DIRECTLY off the client (proven
          // available post-stream; the onTurnComplete callback alone was
          // unreliable here). The cursor is load-bearing: the NEXT message's
          // fresh AgentChat must be constructed hydrated (session:{lastEventId})
          // or its sessions.start short-circuits on idempotency and the append
          // lands in the dead one-turn run's inbox — message never dispatches
          // (server only probes/re-triggers on the hydrated append path).
          const cursor = (chatClient as any)?.session?.lastEventId as string | undefined;
          if (cursor) {
            await (this.redis as any)
              .set(
                // SECURITY (audit L4) — MUST match the scoped cursorKey built
                // on the read side; a mismatch breaks cursor hydration.
                `chatsess:cursor:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${threadId}`,
                cursor,
                "EX",
                60 * 60 * 24 * 30,
              )
              .catch(() => undefined);
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
      }
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
    // The DECISION (executionMode read), the trigger-availability gate, the
    // IDOR-gated thread resolution, and the platos.agent.durable-turn send now
    // ALL live in TurnDispatchService.triggerDurable (the chokepoint) —
    // extracted verbatim, so the dashboard durable path is byte-for-byte
    // unchanged. handleMessage only reaches here when resolveMode already
    // returned "durable"; this method owns solely the socket TAIL.
    //
    // Fail-open: any dispatch failure (trigger unconfigured, thread resolution,
    // trigger send) throws out of triggerDurable → we return false →
    // handleMessage falls through to the identical in-process path below. Never
    // a dropped turn.
    let handle: { runId?: string; threadId: string };
    try {
      handle = await this.dispatch.triggerDurable(agentId, {
        scope,
        message: data.message,
        threadId: data?.threadId as string | undefined,
        replyToMessageId: replyToMessageId ?? null,
        idempotencyKey: (data as any).idempotencyKey as string | undefined,
      });
    } catch {
      return false; // fail-open → direct in-process path
    }

    await client.join(`thread:${handle.threadId}`);
    // Bridge the durable run's realtime events into the thread room (client is
    // joined). RunsBridge no-ops if the SDK realtime isn't available. This is
    // the SAME dashboard streaming path as before — unchanged.
    if (handle.runId) this.getRunsBridge()?.subscribe(handle.runId, scope, handle.threadId);
    client.emit("agent_event", {
      type: "meta",
      thread_id: handle.threadId,
      threadId: handle.threadId,
      durable: true,
      runId: handle.runId,
      ...(replyToMessageId ? { replyToMessageId } : {}),
    });
    return true;
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
      // SECURITY (audit H3) — gate by OWNERSHIP, not just scope. A bare
      // scope-filtered findFirst let any same-scope socket join
      // thread:<victimId> and receive the victim's live agent_event stream
      // (tokens, tool_results, batch output PII). getThread ORs
      // userId/createdByUserId under the scope tuple; operators (dashboard)
      // may view any thread in scope via allUsers.
      const convo = (this.agentTaskService as any).conversationService;
      const thread = await convo?.getThread?.(data.threadId, scope, {
        allUsers: scope.principal === "operator",
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
    // SECURITY (audit H5) — only the requester or an operator may resolve.
    // Fail CLOSED on a null requestedBy (userless context): a non-operator
    // must have a concrete requestedBy that matches their own userId. A null
    // requester must never match a null/undefined scope.userId.
    if (
      scope.principal !== "operator" &&
      ((found as any).requestedBy == null ||
        (found as any).requestedBy !== scope.userId)
    ) {
      client.emit("approval_response_error", {
        approvalId: data.approvalId,
        error: "Only the requesting user or an operator may resolve this approval",
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
      // SECURITY (audit H4 regression) — include the owner's user room; the
      // renamer left the scope room, so without this their other tabs / list
      // view never see their own rename.
      const userRoom = this.userRoom(scope);
      this.server?.to(scopeRoom).to(threadRoom).to(userRoom).emit("thread_event", event);
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
    // SECURITY (audit H13) — the set-key carries a trailing
    // :${replyToMessageId ?? "main"} segment (a thread can have a main turn +
    // sub-thread turns), so an exact-key lookup NEVER matched → stop was a
    // silent no-op (UI showed "done" while the model kept streaming + billing).
    // Match every in-flight turn for THIS user + thread by prefix and abort.
    const prefix = `${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${scope.userId}:${data.threadId}:`;
    let aborted = false;
    for (const [k, controller] of this.activeStreams) {
      if (k.startsWith(prefix)) {
        controller.abort();
        this.activeStreams.delete(k);
        aborted = true;
      }
    }
    // Only claim "done/stopped" if we actually aborted something.
    if (aborted) {
      client.emit("agent_event", { type: "done", threadId: data.threadId, stopped: true });
    }
  }
}
