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
import {
  type ControlDatabaseClient,
  environmentScopeWhere,
  PRISMA_TOKEN,
} from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";
import { MonitoringApprovalsService } from "../monitoring/approvals.service";
import { approvalRedisKey } from "../monitoring/approval-keys";
import { RateLimitService } from "../monitoring/rate-limit.service";
import { SafetyEventService } from "../monitoring/safety-event.service";
import { assertsIdentity, stripAssertedIdentity } from "./session-context-override";

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
// `env` proxy here would cause strict parse before the bootstrap handler
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
    // DECISION (executionMode read) from here, and durable ALWAYS means a
    // Trigger SESSION driven inside the chokepoint (dispatch.streamSession). The
    // gateway keeps only the socket TAIL: room join + meta emit to the client +
    // the background pump of the session's frames to the thread room.
    private readonly dispatch: TurnDispatchService,
    private readonly authService: AuthService,
    @Inject(REDIS_TOKEN) private readonly redis: IORedis,
    // Phase 1 review follow-up — Prisma is needed on the gateway so
    // `join_thread` can scope-gate the thread lookup. DatabaseModule is
    // `@Global()`, so PRISMA_TOKEN resolves without changing module imports.
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
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
        // Platform-signed scoped JWT. Entity end-user tokens are additionally
        // revalidated against their persisted McpBearerToken by AuthService.
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
        // not target a different agent. Operator tokens have no entity bearer
        // authorization and are not guests (mirrors the HTTP ScopeGuard).
        // Runtime-computed signing provenance is required because an
        // entity-secret-signed browser token has no authorizationId either.
        pinnedAgentId = (payload as any).agentId;
        principal =
          payload.signingProvenance === "platform" &&
          payload.authorizationId === undefined &&
          (payload as any).isGuest !== true
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
        // Retain the signed token for per-event lifecycle revalidation. An
        // entity bearer revoked after the socket connected must not authorize
        // subsequent messages on a long-lived connection.
        (client as any).platosSessionToken = String(token);
        const expiresInMs = Math.max(1, payload.exp * 1000 - Date.now());
        const expiryTimer = setTimeout(() => {
          client.emit("error", {
            code: "SESSION_EXPIRED",
            message: "Session token expired.",
          });
          client.disconnect();
        }, expiresInMs);
        expiryTimer.unref?.();
        (client as any).platosSessionExpiryTimer = expiryTimer;
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
              // WIN-133 — the signed copy, kept out of the prompt bag that
              // handleMessage merges a client override into. This is the only
              // provenance turns_v1's plaintext identity columns accept; see
              // RequestScope.signedUserMeta.
              signedUserMeta: {
                ...(userMeta.name ? { name: userMeta.name } : {}),
                ...(userMeta.email ? { email: userMeta.email } : {}),
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
    const expiryTimer = (client as any).platosSessionExpiryTimer as
      | ReturnType<typeof setTimeout>
      | undefined;
    if (expiryTimer) clearTimeout(expiryTimer);
    const scope = (client as any).scope as RequestScope | undefined;
    console.log(
      `[Platos WS] Disconnected: ${client.id} org=${scope?.organizationId || "unknown"} project=${scope?.projectId || "unknown"} env=${scope?.environmentId || "unknown"}`,
    );
  }

  private async revalidateSocketSession(client: Socket): Promise<boolean> {
    const token = (client as any).platosSessionToken as string | undefined;
    if (!token) return true; // trusted internal direct-header connection
    const payload = await this.authService.validateSessionToken(token);
    const scope = (client as any).scope as RequestScope | undefined;
    if (
      !payload ||
      !scope ||
      payload.organizationId !== scope.organizationId ||
      payload.projectId !== scope.projectId ||
      payload.environmentId !== scope.environmentId ||
      payload.userId !== scope.userId
    ) {
      client.emit("error", {
        code: "SESSION_REVOKED_OR_EXPIRED",
        message: "Session authorization is no longer active.",
      });
      client.disconnect();
      return false;
    }
    return true;
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
    if (!(await this.revalidateSocketSession(client))) return;
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
        const threadRow = await this.prisma.thread.findFirst({
          where: {
            id: data.threadId,
            ...environmentScopeWhere(scope),
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
      // Original BUG-11 fix used the system PLATOS_INTERNAL_AUTH_TOKEN, but that's only
      // available to infra operators — broke the legitimate Postman mode flow
      // where org admins simulate user IDs while testing their own agents.
      // Now we check OrgMember.role within scope.organizationId.
      let isOrgAdmin = false;
      // LATENCY (audit F8) — isOrgAdmin is consumed ONLY by the Postman
      // simulation branch below, so skip this org-admin DB lookup entirely on
      // the common path (no postmanUserId). It was an unconditional query on
      // every WS message; guarding it removes one round-trip per turn with no
      // behavior change (effectiveUserId stays scope.userId when not simulating).
      // WIN-133 — the identity half of `sessionContextOverride` is held to the
      // same bar, so the lookup also runs when the override asserts a name or
      // an email. Still skipped on the common path (neither knob used).
      const overrideAssertsIdentity = assertsIdentity(data.sessionContextOverride);
      if (
        (data.postmanUserId && data.postmanUserId !== scope.userId) ||
        overrideAssertsIdentity
      ) {
        try {
          const orgMember = await this.prisma.organizationMembership.findFirst({
            where: {
              userId: scope.userId,
              organizationId: scope.organizationId,
              deactivatedAt: null,
            },
            select: { role: true },
          });
          isOrgAdmin =
            orgMember?.role === "OWNER" || orgMember?.role === "ADMIN";
        } catch {
          // Defensive: if the role lookup blows up, fall through to no-op
          // (effectiveUserId stays as scope.userId — preserves BUG-11 guarantee).
          isOrgAdmin = false;
        }
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
      // WIN-133 — an override that asserts a name or an email from a caller who
      // is not an org admin is a forged identity: the values land on the turn's
      // spans (and used to land on its analytical row) keyed to the ATTACKER'S
      // end_user_id, so erasing the person actually named in them never reaches
      // those rows. Strip the claim, keep the rest of the bag, and say so.
      let sessionContextOverride = data.sessionContextOverride;
      if (sessionContextOverride && overrideAssertsIdentity && !isOrgAdmin) {
        const { sanitized, removed } = stripAssertedIdentity(sessionContextOverride);
        sessionContextOverride = Object.keys(sanitized).length > 0 ? sanitized : undefined;
        this.safetyEventService
          ?.record(
            {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
            {
              detector: "pii",
              action: "block",
              severity: "medium",
              detail: `sessionContextOverride asserted unsigned identity (${removed.join(", ")}) [WS]`,
              agentId,
              userId: scope.userId,
            },
          )
          .catch(() => undefined);
      }
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
        ...(sessionContextOverride
          ? {
              sessionContext: {
                ...(scope.sessionContext as Record<string, unknown> | undefined),
                ...sessionContextOverride,
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
      // executionMode is read for dispatch, across every entry path). A
      // "direct" agent (or a deployment without managed trigger) falls straight
      // through to the in-process stream below — unchanged.
      const dispatchMode = await this.dispatch.resolveMode(agentId, scopeWithAgent);
      if (dispatchMode === "durable") {
        // Durable ALWAYS means a Trigger SESSION now — the chokepoint owns the
        // WHOLE drive (IDOR-gated thread, scope-namespaced Redis cursor, run-
        // finalization race guard, fresh-AgentChat-per-message, .out translate).
        // The gateway keeps ONLY the socket TAIL:
        //   1. await the FIRST frame (meta) — this both learns the resolved
        //      threadId and tells us the session is available; if streamSession
        //      yields nothing (flags off / SDK missing / sub-thread reply /
        //      thread won't resolve) we fall through to the in-process direct
        //      path below (the ONLY fallback — the durable-turn task is retired).
        //   2. join the room + emit meta to the requesting client (mirrors the
        //      former session pump's client.emit).
        //   3. pump the remaining frames to the thread ROOM in a NON-AWAITED
        //      background task so the handler returns while the durable session
        //      keeps producing (a reconnecting client in the room resumes).
        // The async generator is its own iterator — drive it with .next() so we
        // can await the FIRST frame in the foreground (availability decision)
        // and pump the rest in the background.
        const sessionGen = this.dispatch.streamSession(agentId, {
          scope: scopeWithAgent,
          message: data.message,
          threadId: data.threadId,
          replyToMessageId,
          idempotencyKey: (data as any).idempotencyKey as string | undefined,
        });
        const first = await sessionGen.next();
        if (!first.done) {
          const metaEvt = first.value as Record<string, unknown>;
          const tid = (metaEvt.thread_id as string) ?? data.threadId ?? "";
          const room = `thread:${tid}`;
          await client.join(room);
          client.emit("agent_event", metaEvt);
          void (async () => {
            let sawDone = false;
            try {
              for (;;) {
                const n = await sessionGen.next();
                if (n.done) break;
                const frame = n.value as Record<string, unknown>;
                if (frame.type === "done") sawDone = true;
                this.server?.to(room).emit("agent_event", { ...frame, threadId: tid });
              }
            } catch (err: any) {
              this.server?.to(room).emit("agent_event", {
                type: "error",
                message: err?.message ?? String(err),
                threadId: tid,
              });
            } finally {
              // Guarantee a terminal done reaches the room even on the (defensive)
              // path where the stream ends without one.
              if (!sawDone) {
                this.server?.to(room).emit("agent_event", { type: "done", threadId: tid });
              }
            }
          })();
          return;
        }
        // session unavailable → fall through to the in-process direct path below
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
    if (!(await this.revalidateSocketSession(client))) return;
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
    if (!(await this.revalidateSocketSession(client))) return;
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
    if (!(await this.revalidateSocketSession(client))) return;
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
    if (!(await this.revalidateSocketSession(client))) return;
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
      const result = await this.prisma.thread.updateMany({
        where: {
          id: data.threadId,
          ...environmentScopeWhere(scope),
          endUser: {
            identities: {
              some: {
                organizationId: scope.organizationId,
                subject: scope.userId,
                disabledAt: null,
              },
            },
          },
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
    if (!(await this.revalidateSocketSession(client))) return;
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
