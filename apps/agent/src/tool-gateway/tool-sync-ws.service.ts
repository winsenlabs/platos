import { Injectable, Inject, OnApplicationBootstrap, OnApplicationShutdown, Logger, Optional } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { URL } from "node:url";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { ToolRegistryService, type ToolSchema } from "./tool-registry.service";
import { MetricsService } from "../monitoring/metrics.service";
import { env } from "../shared/env";

/**
 * Tool-sync WebSocket server using the platools SDK wire protocol.
 *
 * Protocol (exactly matches platools-js + platools-py transport/protocol):
 *
 * SDK → Platform:
 *   { type: "tool_register", tools: [...] }
 *   { type: "tool_result",   call_id, result, latency_ms }
 *   { type: "tool_error",    call_id, error, traceback? }
 *   { type: "heartbeat",     tools_health: { [name]: { status, avg_latency_ms, error_count_1h, last_error? } } }
 *
 * Platform → SDK:
 *   { type: "welcome",          sdk_connection_id, entity_id, environment_id }
 *   { type: "tool_call",        call_id, tool_name, params }
 *   { type: "heartbeat_ack" }
 *   { type: "tool_health_alert",tool, status, details? }
 *
 * Auth: `Authorization: Bearer <serviceSecret>` header on handshake. Platos
 * resolves the entity row from the secret. The environment is selected via the
 * `env` query-string parameter (e.g. `?entity=fandesk-main&env=dev`). Defaults
 * to the entity's project's DEVELOPMENT env if not specified.
 *
 * The service attaches a raw `ws` server to the Nest HTTP server at path
 * `/tools/sync`. Socket.IO stays on its own /agent namespace untouched.
 */

type PendingCall = {
  callId: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  toolName: string;
  startedAt: number;
  // M5: the entity/env this call was dispatched to. Used to reject forged
  // tool_result/tool_error frames that arrive on a different (cross-tenant)
  // socket which merely knows/guesses the callId.
  entityId: string;
  environmentId: string;
};


type Conn = {
  ws: WebSocket;
  organizationId: string;
  projectId: string;
  environmentId: string;
  entityId: string;    // human-readable slug (was "source"/"orgId")
  entityPk: string;    // Entity.id
  connectionId: string;
  connectedAt: Date;
};

@Injectable()
export class ToolSyncWsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ToolSyncWsService.name);
  private wss: WebSocketServer | null = null;
  /**
   * Keyed by `${entityId}::${environmentId}` — each (entity, env) pair can hold
   * one live connection. Same entity in different envs is totally independent.
   */
  private connections = new Map<string, Conn>();
  private pending = new Map<string, PendingCall>(); // callId → pending promise

  /**
   * Per-(entity, env) sliding window of tool_register timestamps (ms).
   * Used to throttle clients that re-register at storm rates — the
   * 2026-05-19 outage was driven by a fandesk bridge with broken
   * leader election that re-registered 403 tools every ~15 s for 7
   * days, each registration costing ~200 KB JSON parse + 403 DB
   * UPSERTs + BM25 rebuild. The bug lives in the client's leader
   * election, but the server has no business letting one bad client
   * monopolize CPU. Anything above PLATOS_TOOL_REGISTER_MAX_PER_MIN
   * gets a `register_throttled` reply (with retry-after hint) instead
   * of the full re-registration path.
   */
  private registerWindow = new Map<string, number[]>();

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly toolRegistry: ToolRegistryService,
    private readonly httpAdapterHost: HttpAdapterHost,
    // EOBD.41 — optional so unit tests without MonitoringModule boot.
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async onApplicationBootstrap() {
    const httpServer = this.httpAdapterHost.httpAdapter?.getHttpServer?.();
    if (!httpServer) {
      this.logger.warn("No HTTP server — tool sync WS disabled");
      return;
    }

    // EOBD.38 — cap inbound frame size at 10MB. A misbehaving entity
    // that returns a 100MB tool_result would otherwise blow through
    // the LLM context window with a provider-side 413, corrupt the
    // turn, and bloat the toolCalls JSONB column. 10MB is well above
    // any legitimate tool result; anything larger is either an error
    // or abuse. `ws` closes the connection on frame overrun.
    const maxPayload = env.PLATOS_WS_MAX_PAYLOAD_BYTES ?? 10 * 1024 * 1024;
    this.wss = new WebSocketServer({ noServer: true, maxPayload });

    httpServer.on("upgrade", (req: IncomingMessage, socket: any, head: Buffer) => {
      try {
        const parsed = new URL(req.url || "/", `http://${req.headers.host}`);
        const path = parsed.pathname;
        const isToolSyncPath =
          path === "/tools/sync" ||
          path === "/tools/sync/ws/sdk" ||
          path === "/ws/sdk";
        if (!isToolSyncPath) return; // let Socket.IO / others handle
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.wss!.emit("connection", ws, req);
        });
      } catch (err: any) {
        this.logger.warn(`upgrade error: ${err?.message}`);
        try { socket.destroy(); } catch {}
      }
    });

    this.wss.on("connection", async (ws, req) => {
      await this.handleConnection(ws, req);
    });

    this.logger.log("tool-sync WS server attached at /tools/sync (platools protocol)");
  }

  async onApplicationShutdown() {
    for (const conn of this.connections.values()) {
      try { conn.ws.close(1001, "server shutting down"); } catch {}
    }
    this.connections.clear();
    this.wss?.close();
  }

  private connKey(entityId: string, environmentId: string): string {
    return `${entityId}::${environmentId}`;
  }

  // ──────────────────────────────────────────
  // Connection lifecycle
  // ──────────────────────────────────────────

  private async handleConnection(ws: WebSocket, req: IncomingMessage) {
    // ══════════════════════════════════════════════════════════════════════════
    // RACE-FIX (DO NOT DELETE):
    // Buffer any inbound frames that arrive while we do async auth work.
    // Node's `ws` library delivers 'message' events only once a listener is
    // attached — but the first message the SDK sends (tool_register) races
    // against our DB lookup. If we register the real handler after the lookup,
    // we lose that first frame. So: attach an early buffering listener NOW,
    // then swap to the real handler once auth is resolved and replay.
    // ══════════════════════════════════════════════════════════════════════════
    const earlyBuffer: RawData[] = [];
    const earlyListener = (raw: RawData) => earlyBuffer.push(raw);
    ws.on("message", earlyListener);

    const parsed = new URL(req.url || "/", `http://${req.headers.host}`);
    const auth = req.headers["authorization"];
    const secret = typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")
      ? auth.slice(7).trim()
      : "";

    // entity=<slug> selects which registered entity is connecting. ?source=
    // is the older platools spelling and is still accepted, as are the
    // X-Platos-Entity-Id / X-Platos-Source headers. There is deliberately NO
    // default: guessing an entity would bind an unidentified client to
    // whichever entity happened to be named that, so a missing id is a
    // rejection with its own distinct reason (see below).
    const entityIdFromUrl = (
      parsed.searchParams.get("entity") ||
      parsed.searchParams.get("source") ||
      (req.headers["x-platos-entity-id"] as string | undefined) ||
      (req.headers["x-platos-source"] as string | undefined) ||
      ""
    ).trim();

    // env=<slug|id> selects which RuntimeEnvironment the tool mapping should
    // live under. Accepts either the env id or the env type slug (DEVELOPMENT,
    // STAGING, PREVIEW, PRODUCTION, or lower-case aliases dev/prod/…).
    const envQuery = (
      parsed.searchParams.get("env") ||
      (req.headers["x-platos-environment-id"] as string | undefined) ||
      ""
    ).trim();

    if (!secret) {
      this.logger.warn("reject: missing Authorization: Bearer <secret>");
      ws.off("message", earlyListener);
      ws.send(JSON.stringify({ type: "error", error: "Missing Authorization: Bearer <secret>" }));
      ws.close(1008, "missing secret");
      return;
    }

    // A connection with no entity id can never match a credential, and it is
    // NOT a secret problem — reporting it as one sends operators hunting a
    // hash mismatch that does not exist. Reject it on its own terms, before
    // the lookup, so the client is told the one thing it can act on.
    if (!entityIdFromUrl) {
      this.logger.warn(
        "reject: no entity id supplied (pass ?entity=<slug>, ?source=<slug>, or X-Platos-Entity-Id) — secret was not checked",
      );
      ws.off("message", earlyListener);
      ws.send(
        JSON.stringify({
          type: "error",
          error:
            "Missing entity id. Connect with ?entity=<slug> (or the X-Platos-Entity-Id header). Your service secret was not the problem.",
        }),
      );
      ws.close(1008, "missing entity id");
      return;
    }

    // Resolve the clean Environment + Entity first, then verify the
    // Environment-owned ENTITY_SECRET credential by hash. Raw secret material
    // is never persisted on Entity.
    let entityRow: any = null;
    let environmentId = "";
    try {
      const digest = createHash("sha256").update(secret).digest("hex");
      const credentials = await this.prisma.credential.findMany({
        where: {
          kind: "ENTITY_SECRET",
          name: entityIdFromUrl,
          secretHash: { in: [digest, `sha256:${digest}`] },
          revokedAt: null,
        },
        include: {
          environment: {
            select: {
              id: true,
              slug: true,
              project: {
                select: {
                  id: true,
                  organizationId: true,
                  entities: {
                    where: {
                      externalId: entityIdFromUrl,
                      connectionKind: "wire",
                    },
                    select: {
                      id: true,
                      externalId: true,
                      projectId: true,
                      connectionKind: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { id: "asc" },
      });
      const candidates = credentials.flatMap((credential: any) =>
        this.matchesEnvironment(credential.environment, envQuery)
          ? credential.environment.project.entities.map((entity: any) => ({
              entity: {
                ...entity,
                project: {
                  organizationId:
                    credential.environment.project.organizationId,
                },
              },
              environment: credential.environment,
            }))
          : [],
      );
      if (candidates.length !== 1) {
        throw new Error(
          candidates.length === 0
            ? "entity/environment not found"
            : "entity/environment is ambiguous; pass an environment id",
        );
      }
      entityRow = candidates[0]!.entity;
      environmentId = candidates[0]!.environment.id;
    } catch (err: any) {
      this.logger.warn(`entity secret lookup failed: ${err?.message}`);
    }
    if (!entityRow) {
      this.logger.warn(`reject: no entity matched secret${entityIdFromUrl ? ` for entityId=${entityIdFromUrl}` : ""}`);
      ws.off("message", earlyListener);
      ws.send(JSON.stringify({ type: "error", error: "Invalid service secret or entity not found" }));
      ws.close(1008, "invalid secret");
      return;
    }

    if (!environmentId) {
      this.logger.warn(`reject: could not resolve env for entity ${entityRow.externalId} (env hint="${envQuery}")`);
      ws.off("message", earlyListener);
      ws.send(JSON.stringify({ type: "error", error: "Could not resolve environment for this entity/project" }));
      ws.close(1008, "unresolvable env");
      return;
    }

    const key = this.connKey(entityRow.externalId, environmentId);
    const prev = this.connections.get(key);
    if (prev) {
      try { prev.ws.close(1000, "superseded by new connection"); } catch {}
    }

    const connectionId = randomUUID();
    const conn: Conn = {
      ws,
      organizationId: entityRow.project.organizationId,
      projectId: entityRow.projectId,
      environmentId,
      entityId: entityRow.externalId,
      entityPk: entityRow.id,
      connectionId,
      connectedAt: new Date(),
    };
    this.connections.set(key, conn);
    // EOBD.41 — gauge reflects live WS connections.
    this.metrics?.wsConnectionsGauge.set(this.connections.size);

    this.send(ws, {
      type: "welcome",
      sdk_connection_id: connectionId,
      entity_id: entityRow.externalId,
      environment_id: environmentId,
      organization_id: entityRow.project.organizationId,
      project_id: entityRow.projectId,
    });

    // Mark connected in DB
    try {
      await this.prisma.entity.update({
        where: { id: entityRow.id },
        data: { connectionStatus: "connected", lastConnectedAt: new Date() },
      });
    } catch {
      // best-effort
    }
    this.toolRegistry.setEntityDispatchable(entityRow.id, true, environmentId);

    this.logger.log(
      `entity ${entityRow.externalId} / env=${environmentId} connected (conn=${connectionId.slice(0, 8)}, buffered=${earlyBuffer.length})`,
    );

    const realMessageHandler = async (raw: RawData) => {
      this.logger.log(`[raw ${entityRow.externalId}/${environmentId}] bytes=${raw.toString().length}`);
      await this.handleMessage(conn, raw).catch((err) => {
        this.logger.warn(`handleMessage error (${entityRow.externalId}/${environmentId}): ${err?.message}`);
      });
    };

    // ══════════════════════════════════════════════════════════════════════════
    // RACE-FIX (DO NOT DELETE):
    // Swap early listener → real handler. Detach the buffer first so no frame
    // is double-processed. Then replay anything the SDK sent during the auth
    // round-trip (typically tool_register immediately on open).
    // ══════════════════════════════════════════════════════════════════════════
    ws.off("message", earlyListener);
    ws.on("message", realMessageHandler);

    for (const raw of earlyBuffer) {
      await realMessageHandler(raw);
    }

    ws.on("close", async (code, reason) => {
      if (this.connections.get(key)?.ws === ws) {
        this.connections.delete(key);
        this.metrics?.wsConnectionsGauge.set(this.connections.size);
      }
      // Only mark entity disconnected if NO env connections remain
      const anyLeft = Array.from(this.connections.values()).some(
        (c) => c.entityPk === entityRow.id,
      );
      if (!anyLeft) {
        try {
          await this.prisma.entity.update({
            where: { id: entityRow.id },
            data: { connectionStatus: "disconnected" },
          });
        } catch {}
      }
      this.toolRegistry.setEntityDispatchable(entityRow.id, false, environmentId);
      this.logger.log(
        `entity ${entityRow.externalId} / env=${environmentId} disconnected code=${code} reason=${reason?.toString() || ""}`,
      );
    });

    ws.on("error", (err) => {
      this.logger.warn(`ws error for entity ${entityRow.externalId}/${environmentId}: ${err?.message}`);
    });
  }

  /**
   * Force-close every active WebSocket session whose `(organizationId,
   * projectId, entityId)` matches. Called by `regenerateServiceSecret`
   * so the old secret is invalidated for in-flight connections, not
   * just for new handshakes. Without this, an entity backend that
   * still holds the old secret keeps receiving + answering tool calls
   * indefinitely after rotation, which defeats the purpose of
   * "rotating" (and is the bug a user hit on 2026-05-05 with the
   * docs-mcp-bridge / Winsen Bridge entities).
   *
   * Returns the count of connections closed. Idempotent — calling it
   * for an entity with no live sessions is a no-op.
   */
  disconnectEntity(
    organizationId: string,
    projectId: string,
    entityId: string,
  ): number {
    let closed = 0;
    for (const conn of this.connections.values()) {
      if (
        conn.organizationId === organizationId &&
        conn.projectId === projectId &&
        conn.entityId === entityId
      ) {
        try {
          // 4001 is a custom close code we use for "credentials
          // invalidated, reconnect with the new secret." The platools
          // SDK's reconnect loop kicks in on close and handshakes
          // again; if the SDK has the new secret it succeeds, if it
          // has the old one the handshake fails and the operator gets
          // a clear log line on both sides.
          conn.ws.close(4001, "secret rotated; reconnect with new secret");
          closed++;
        } catch (err) {
          this.logger.warn(
            `[disconnectEntity ${conn.entityId}/${conn.environmentId}] close failed: ${(err as Error)?.message ?? err}`,
          );
        }
      }
    }
    if (closed > 0) {
      this.logger.log(
        `[disconnectEntity ${entityId}] closed ${closed} session(s) after secret rotation`,
      );
    }
    return closed;
  }

  // ──────────────────────────────────────────
  // Inbound message handling (SDK → Platform)
  // ──────────────────────────────────────────

  private async handleMessage(conn: Conn, raw: RawData) {
    const { ws, entityId, environmentId } = conn;
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed
    }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;

    this.logger.log(`[msg ${entityId}/${environmentId}] type=${msg.type}`);
    switch (msg.type) {
      case "tool_register": {
        // Defense-in-depth (2026-05-19 post-mortem): cap re-registration
        // frequency per (entity, env). Bug-free clients hit this once at
        // startup and rarely after; the only callers that exceed the cap
        // are buggy reconnect loops. Without this gate, one broken
        // client can monopolize the agent's CPU.
        const rateLimitKey = this.connKey(entityId, environmentId);
        const nowMs = Date.now();
        const maxPerMin = Number(
          process.env.PLATOS_TOOL_REGISTER_MAX_PER_MIN ?? "6",
        );
        const windowMs = 60_000;
        const recent = (this.registerWindow.get(rateLimitKey) ?? []).filter(
          (ts) => nowMs - ts < windowMs,
        );
        if (recent.length >= maxPerMin) {
          const retryAfterMs = windowMs - (nowMs - recent[0]!);
          this.logger.warn(
            `entity ${entityId}/${environmentId}: tool_register throttled (${recent.length}/${maxPerMin} per min) — retry-after ${Math.ceil(retryAfterMs / 1000)}s`,
          );
          this.send(ws, {
            type: "register_throttled",
            error: `tool_register exceeded ${maxPerMin}/min; retry after ${Math.ceil(retryAfterMs / 1000)}s`,
            retry_after_ms: retryAfterMs,
          });
          return;
        }
        recent.push(nowMs);
        this.registerWindow.set(rateLimitKey, recent);

        const tools = Array.isArray(msg.tools) ? msg.tools : [];
        const normalized: ToolSchema[] = tools.map((t: any) => ({
          name: t.name,
          description: t.description,
          paramSchema: t.input_schema ?? t.paramSchema ?? {},
          category: t.annotations?.category || t.category || undefined,
        }));
        const callbackUrl =
          msg.callback_url || `ws://platos/tools/sync?entity=${entityId}&env=${environmentId}`;
        try {
          const result = await this.toolRegistry.registerTools(
            {
              organizationId: conn.organizationId,
              projectId: conn.projectId,
              environmentId: conn.environmentId,
              entityPk: conn.entityPk,
              sourceEntityId: conn.entityId,
            },
            normalized,
            callbackUrl,
          );
          // tool_register is a complete declaration. registerTools commits the
          // replacement (including shrink cleanup) atomically before touching
          // cache/index state; there is no additive/partial registration mode.
          const pruned = result.removed;
          this.send(ws, {
            type: "tools_registered",
            entity_id: entityId,
            environment_id: environmentId,
            count: result.registered,
            new_tools: result.newTools,
            updated: result.updated,
            pruned,
          });
          this.logger.log(
            `entity ${entityId}/env=${environmentId}: registered ${result.registered} tools (+${result.newTools} new, ${result.updated} updated, -${pruned} pruned)`,
          );
        } catch (err: any) {
          this.logger.warn(`entity ${entityId}/${environmentId}: tool_register failed — ${err?.message}`);
          this.send(ws, { type: "error", error: `tool_register failed: ${err?.message}` });
        }
        return;
      }

      case "tool_result": {
        const callId = String(msg.call_id || "");
        const pending = this.pending.get(callId);
        if (!pending) return;
        // M5: reject a tool_result frame whose responding socket is not the
        // entity/env this call was dispatched to. Return early WITHOUT
        // consuming the pending entry so the legitimate responder can still
        // resolve it — prevents a cross-tenant entity that knows a live callId
        // from injecting a forged result.
        if (pending.entityId !== conn.entityId || pending.environmentId !== conn.environmentId) {
          this.logger.warn(
            `[tool_result] responder mismatch for call ${callId}: got ${conn.entityId}/${conn.environmentId}, expected ${pending.entityId}/${pending.environmentId} — dropping frame`,
          );
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(callId);
        // EOBD.38 — app-layer truncation. 10MB ws frame cap rejects the
        // worst case, but a 1MB tool_result still blows past reasonable
        // LLM context budgets + bloats PlatosAgentMessage.toolCalls. If
        // the serialized result exceeds 256KB, replace with a typed
        // truncation envelope so the UI can surface it and the LLM
        // sees the preview only.
        const truncLimit = env.PLATOS_TOOL_RESULT_MAX_BYTES ?? 256 * 1024;
        let result: unknown = msg.result;
        try {
          const serialized = typeof result === "string" ? result : JSON.stringify(result);
          if (serialized && serialized.length > truncLimit) {
            result = {
              truncated: true,
              preview: serialized.slice(0, 4096),
              original_bytes: serialized.length,
            };
          }
        } catch {
          // EOBD.38 (W12 review follow-up) — cyclic / unserializable
          // payload. Replace with a typed envelope so the 256KB cap is
          // never bypassed by a malformed result. Downstream still
          // sees `truncated: true` and can render a user-friendly
          // error.
          result = {
            truncated: true,
            error: "serialization_failed",
            original_bytes: 0,
          };
        }
        pending.resolve({
          status: "success",
          result,
          latencyMs: typeof msg.latency_ms === "number" ? msg.latency_ms : Date.now() - pending.startedAt,
        });
        return;
      }

      case "tool_error": {
        const callId = String(msg.call_id || "");
        const pending = this.pending.get(callId);
        if (!pending) return;
        // M5: reject a tool_error frame whose responding socket is not the
        // entity/env this call was dispatched to. Return early WITHOUT
        // consuming the pending entry so the legitimate responder can still
        // settle it — prevents a cross-tenant entity from aborting another
        // tenant's in-flight call via a known callId.
        if (pending.entityId !== conn.entityId || pending.environmentId !== conn.environmentId) {
          this.logger.warn(
            `[tool_error] responder mismatch for call ${callId}: got ${conn.entityId}/${conn.environmentId}, expected ${pending.entityId}/${pending.environmentId} — dropping frame`,
          );
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(callId);
        // Observability: the receipt log above only prints `type=tool_error`,
        // which swallows the connector's actual error message and makes
        // connector-side failures (e.g. a thrown identity/auth check) opaque
        // from the platform logs. Surface the error string + first traceback
        // line here so the *cause* is visible without needing the connector's
        // own logs. Truncated to keep the line bounded.
        {
          const errStr = String(msg.error || "tool_error").slice(0, 500);
          const tb =
            typeof msg.traceback === "string" ? ` | tb: ${msg.traceback.split("\n")[0]?.slice(0, 300)}` : "";
          this.logger.warn(
            `[tool_error] ${conn.entityId}/${conn.environmentId} tool=${pending.toolName} call=${callId} error="${errStr}"${tb}`,
          );
        }
        pending.reject(new Error(String(msg.error || "tool_error")));
        return;
      }

      case "heartbeat": {
        const toolsHealth = msg.tools_health || {};
        const scopedTools = this.toolRegistry.getScopedTools(
          { organizationId: conn.organizationId, projectId: conn.projectId, environmentId: conn.environmentId },
          { sourceEntityId: conn.entityId, enabledOnly: false },
        );
        for (const [toolName, healthEntry] of Object.entries<any>(toolsHealth)) {
          try {
            const entry = scopedTools.find((t) => t.toolName === toolName);
            if (entry) {
              await this.prisma.toolHealth
                .upsert({
                  where: {
                    environmentId_toolId_entityExternalId: {
                      environmentId: conn.environmentId,
                      toolId: entry.toolId,
                      entityExternalId: conn.entityId,
                    },
                  },
                  update: {
                    lastStatus: healthEntry.status,
                    avgLatencyMs: healthEntry.avg_latency_ms ?? 0,
                  },
                  create: {
                    toolId: entry.toolId,
                    entityExternalId: conn.entityId,
                    environmentId: conn.environmentId,
                    lastStatus: healthEntry.status,
                    avgLatencyMs: healthEntry.avg_latency_ms ?? 0,
                    failCount: 0,
                    totalCalls: 0,
                  },
                })
                .catch(() => {});
            }
          } catch {
            // best-effort — don't break heartbeat
          }
          if (healthEntry?.status === "degraded" || healthEntry?.status === "down") {
            this.send(ws, {
              type: "tool_health_alert",
              tool: toolName,
              status: healthEntry.status,
              details: {
                avg_latency_ms: healthEntry.avg_latency_ms,
                error_count_1h: healthEntry.error_count_1h,
                last_error: healthEntry.last_error,
              },
            });
          }
        }
        this.send(ws, { type: "heartbeat_ack" });
        return;
      }

      default:
        return;
    }
  }

  // ──────────────────────────────────────────
  // Outbound tool dispatch (Platform → SDK)
  // ──────────────────────────────────────────

  /**
   * Dispatch a tool call to an entity's connected SDK in a specific environment.
   *
   * PPR-30: accepts an optional pre-generated `callId` so the caller can
   * embed it into the `__platos` envelope inside `params` before send.
   * When omitted we mint one here (legacy callers). The outer `call_id`
   * field on the wire frame and the envelope's `callId` must always
   * agree — the executor guarantees this by generating once and passing
   * through.
   */
  async dispatchToolCall(
    entityId: string,
    environmentId: string,
    toolName: string,
    params: Record<string, unknown>,
    timeoutMs = 30_000,
    callId?: string,
  ): Promise<{ status: "success"; result: unknown; latencyMs: number }> {
    const conn = this.connections.get(this.connKey(entityId, environmentId));
    const ws = conn?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Entity ${entityId} / env ${environmentId} is not connected (no active WebSocket)`);
    }

    const resolvedCallId = callId ?? randomUUID();
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(resolvedCallId);
        reject(new Error(`Tool call timed out after ${timeoutMs}ms: ${toolName}`));
      }, timeoutMs);

      this.pending.set(resolvedCallId, {
        callId: resolvedCallId,
        resolve: resolve as any,
        reject,
        timer,
        toolName,
        startedAt,
        // M5: bind to the entity/env this call is being sent to.
        entityId,
        environmentId,
      });

      this.send(ws, {
        type: "tool_call",
        call_id: resolvedCallId,
        tool_name: toolName,
        params,
      });
    });
  }

  // ──────────────────────────────────────────
  // Introspection
  // ──────────────────────────────────────────

  isEntityConnected(entityId: string, environmentId: string): boolean {
    const c = this.connections.get(this.connKey(entityId, environmentId));
    return !!c && c.ws.readyState === WebSocket.OPEN;
  }

  getConnectedEntities(): string[] {
    const set = new Set<string>();
    for (const c of this.connections.values()) {
      if (c.ws.readyState === WebSocket.OPEN) set.add(c.entityId);
    }
    return Array.from(set).sort();
  }

  getConnectedEntitiesInEnv(environmentId: string): string[] {
    const set = new Set<string>();
    for (const c of this.connections.values()) {
      if (c.ws.readyState === WebSocket.OPEN && c.environmentId === environmentId) {
        set.add(c.entityId);
      }
    }
    return Array.from(set).sort();
  }

  /** List all (entityId, environmentId) pairs currently connected. */
  getConnectedSources(): Array<{
    organizationId: string;
    projectId: string;
    environmentId: string;
    entityId: string;
    connectionId: string;
    connectedAt: Date;
  }> {
    return Array.from(this.connections.values())
      .filter((c) => c.ws.readyState === WebSocket.OPEN)
      .map((c) => ({
        organizationId: c.organizationId,
        projectId: c.projectId,
        environmentId: c.environmentId,
        entityId: c.entityId,
        connectionId: c.connectionId,
        connectedAt: c.connectedAt,
      }));
  }

  // ──────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────

  private matchesEnvironment(
    environment: { id: string; slug: string },
    hint: string,
  ): boolean {
    const normalized = hint.trim().toLowerCase();
    if (!normalized) {
      return ["dev", "development"].includes(environment.slug.toLowerCase());
    }
    if (environment.id === hint) return true;
    const aliases: Record<string, string[]> = {
      dev: ["dev", "development"],
      development: ["dev", "development"],
      stage: ["stage", "staging"],
      staging: ["stage", "staging"],
      prod: ["prod", "production"],
      production: ["prod", "production"],
      preview: ["preview"],
    };
    return (aliases[normalized] ?? [normalized]).includes(
      environment.slug.toLowerCase(),
    );
  }

  private send(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(msg)); } catch { /* socket closed mid-send */ }
  }
}
