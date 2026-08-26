/**
 * SDK-side WebSocket client that talks to the Platos platform.
 *
 * Mirrors `platools/transport/client.py` with identical defaults so
 * both SDKs behave the same on the wire:
 *
 *   - Heartbeat every 30s (`HEARTBEAT_INTERVAL`), per PRD §5.2.
 *   - Exponential backoff on reconnect starting at `BACKOFF_BASE`
 *     (1s), doubling with every retry, capped at `BACKOFF_MAX` (60s).
 *   - JWT auth via the `Authorization: Bearer <secret>` header.
 *   - Outbound only — the SDK connects to the platform, the
 *     platform never calls the SDK (PRD §5.7).
 *
 * Usage (from user code):
 *
 *     const platools = new Platools({ url, secret });
 *     platools.tool({ ... }, async (...) => ...);
 *     await platools.connect();   // runs forever, reconnecting
 *
 * This module pulls in `ws` (the de-facto WebSocket client for
 * Node). The Python SDK uses `websockets`; neither is a browser
 * client — platools SDK consumers are backends.
 */

import { WebSocket as NodeWebSocket } from "ws";

import type { ToolRegistry } from "../core/registry.js";
import { buildPlatosContext, envelopeToContext, runWithContext } from "../context.js";
import {
  type HeartbeatMessage,
  type PlatformToSdk,
  type SdkToPlatform,
  type ToolCallMessage,
  type ToolErrorMessage,
  type ToolRegisterMessage,
  type ToolResultMessage,
  type ToolSchemaPayload,
  decodePlatformMessage,
  encodeSdkMessage,
} from "./protocol.js";

/** Heartbeat cadence in milliseconds. Matches Python's 30s. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Initial backoff delay in milliseconds. */
export const BACKOFF_BASE_MS = 1_000;

/** Maximum backoff delay in milliseconds. Matches Python's 60s cap. */
export const BACKOFF_MAX_MS = 60_000;

/**
 * Compute the next reconnect delay given the retry count
 * (1-indexed). Pure function so unit tests can lock the curve down.
 *
 * The curve is `base * 2^(retryCount - 1)` capped at `max`, identical
 * to `platools/transport/client.py` — regression-tested in
 * `tests/backoff.test.ts`.
 */
export function backoffDelayMs(
  retryCount: number,
  base: number = BACKOFF_BASE_MS,
  max: number = BACKOFF_MAX_MS,
): number {
  if (retryCount < 1) return 0;
  const raw = base * 2 ** (retryCount - 1);
  return Math.min(raw, max);
}

/** Abstract WebSocket contract so tests can inject a mock. */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "open", listener: () => void): void;
}

/** Factory signature — tests inject a fake to drive the state machine. */
export type WsFactory = (url: string, headers: Record<string, string>) => WsLike;

/** Sleep helper. Tests inject a fake to step the clock deterministically. */
export type Sleeper = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Logger interface — the client defaults to `console` but tests capture output. */
export interface ClientLogger {
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const defaultLogger: ClientLogger = {
  warn: (...args) => console.warn("[platools]", ...args),
  info: (...args) => console.info("[platools]", ...args),
  error: (...args) => console.error("[platools]", ...args),
};

const defaultSleeper: Sleeper = (ms, signal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal !== undefined) {
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });

const defaultWsFactory: WsFactory = (url, headers) =>
  new NodeWebSocket(url, { headers }) as unknown as WsLike;

export interface PlatoolsClientOptions {
  readonly url: string;
  readonly secret: string;
  readonly registry: ToolRegistry;
  readonly heartbeatIntervalMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
  readonly wsFactory?: WsFactory;
  readonly sleeper?: Sleeper;
  readonly logger?: ClientLogger;
}

/**
 * Async WebSocket client binding a `ToolRegistry` to a remote
 * platform. Call `runForever()` from your app bootstrap; it will
 * reconnect on drop until `stop()` is called.
 */
export class PlatoolsClient {
  private readonly url: string;
  private readonly secret: string;
  private readonly registry: ToolRegistry;
  private readonly heartbeatIntervalMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly wsFactory: WsFactory;
  private readonly sleeper: Sleeper;
  private readonly logger: ClientLogger;

  private stopController: AbortController = new AbortController();
  private activeWs: WsLike | null = null;

  public constructor(options: PlatoolsClientOptions) {
    if (!options.url) {
      throw new Error("PlatoolsClient requires a url (set PLATOS_URL)");
    }
    if (!options.secret) {
      throw new Error("PlatoolsClient requires a secret (set PLATOS_SECRET)");
    }
    this.url = options.url;
    this.secret = options.secret;
    this.registry = options.registry;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? BACKOFF_MAX_MS;
    this.wsFactory = options.wsFactory ?? defaultWsFactory;
    this.sleeper = options.sleeper ?? defaultSleeper;
    this.logger = options.logger ?? defaultLogger;
  }

  /**
   * Connect, register tools, process tool calls, and reconnect on
   * drop. Exits cleanly when `stop()` is called from another
   * task or the platform closes the connection.
   */
  public async runForever(): Promise<void> {
    let retryCount = 0;
    while (!this.stopController.signal.aborted) {
      try {
        await this.runSession();
        retryCount = 0; // reset after a clean session
      } catch (err) {
        this.logger.warn("platools ws session ended:", formatError(err));
      }
      if (this.stopController.signal.aborted) return;
      retryCount += 1;
      const delay = backoffDelayMs(retryCount, this.backoffBaseMs, this.backoffMaxMs);
      this.logger.info(
        `platools reconnect in ${(delay / 1000).toFixed(1)}s (retry ${retryCount})`,
      );
      await this.sleeper(delay, this.stopController.signal);
    }
  }

  /** Stop the reconnect loop and close the active socket (if any). */
  public async stop(): Promise<void> {
    this.stopController.abort();
    if (this.activeWs !== null) {
      try {
        this.activeWs.close(1000, "client stop");
      } catch {
        // already closed; nothing to do
      }
      this.activeWs = null;
    }
  }

  /**
   * Compute the normalized WebSocket URL. Mirrors the Python
   * SDK's `_ws_url` — swaps `http://` → `ws://` / `https://` →
   * `wss://`, strips trailing slashes from the *path*, and inserts
   * `/ws/sdk` before any query string. Concatenating the suffix
   * after the query corrupts the last query value
   * (`?env=prod` → `?env=prod/ws/sdk`).
   */
  public websocketUrl(): string {
    let base = this.url;
    if (base.startsWith("http://")) base = `ws://${base.slice("http://".length)}`;
    else if (base.startsWith("https://")) base = `wss://${base.slice("https://".length)}`;
    const qIdx = base.indexOf("?");
    const path = qIdx >= 0 ? base.slice(0, qIdx) : base;
    const query = qIdx >= 0 ? base.slice(qIdx) : "";
    return `${path.replace(/\/+$/, "")}/ws/sdk${query}`;
  }

  /**
   * Run one WebSocket session: connect, register, dispatch calls.
   * Resolves when the socket closes; rejects on connection
   * errors (the reconnect loop in `runForever` handles both).
   */
  public async runSession(): Promise<void> {
    const ws = this.wsFactory(this.websocketUrl(), {
      Authorization: `Bearer ${this.secret}`,
    });
    this.activeWs = ws;

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = (): void => {
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      this.activeWs = null;
    };

    return new Promise<void>((resolve, reject) => {
      let opened = false;

      ws.on("open", () => {
        opened = true;
        try {
          this.sendRegistration(ws);
        } catch (err) {
          cleanup();
          reject(err);
          return;
        }
        heartbeatTimer = setInterval(() => {
          this.sendHeartbeat(ws);
        }, this.heartbeatIntervalMs);
      });

      ws.on("message", (data: unknown) => {
        const raw = typeof data === "string" ? data : data instanceof Buffer ? data.toString("utf8") : String(data);
        const message = decodePlatformMessage(raw);
        if (message === null) {
          this.logger.warn("platools received malformed message");
          return;
        }
        this.handlePlatformMessage(ws, message).catch((err: unknown) => {
          this.logger.error("platools dispatch error:", formatError(err));
        });
      });

      ws.on("close", () => {
        cleanup();
        resolve();
      });

      ws.on("error", (err: Error) => {
        cleanup();
        if (opened) {
          // Error after a clean open — treat as session ending,
          // the reconnect loop kicks in.
          resolve();
        } else {
          reject(err);
        }
      });
    });
  }

  private sendRegistration(ws: WsLike): void {
    const payloads: ToolSchemaPayload[] = this.registry.all().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      output_schema: tool.outputSchema,
      auth: tool.auth,
      roles: [...tool.roles],
      annotations: tool.annotations,
    }));
    const message: ToolRegisterMessage = { type: "tool_register", tools: payloads };
    ws.send(encodeSdkMessage(message satisfies SdkToPlatform));
  }

  private sendHeartbeat(ws: WsLike): void {
    const message: HeartbeatMessage = { type: "heartbeat", tools_health: {} };
    try {
      ws.send(encodeSdkMessage(message satisfies SdkToPlatform));
    } catch (err) {
      this.logger.warn("platools heartbeat send failed:", formatError(err));
    }
  }

  private async handlePlatformMessage(
    ws: WsLike,
    message: PlatformToSdk,
  ): Promise<void> {
    switch (message.type) {
      case "tool_call":
        await this.dispatchCall(ws, message);
        return;
      case "welcome":
      case "heartbeat_ack":
      case "tools_registered":
        // informational — no action required
        return;
      case "register_throttled":
        // The platform refused the batch; the reconnect/re-register path will
        // try again. Surface it so a persistent throttle is visible rather
        // than looking like silent registration success.
        this.logger.warn(
          `platools registration throttled: ${message.error}${
            message.retry_after_ms === undefined
              ? ""
              : ` (retry in ${Math.ceil(message.retry_after_ms / 1000)}s)`
          }`,
        );
        return;
      case "tool_health_alert":
        this.logger.warn(
          `platools tool health: ${message.tool} is ${message.status}`,
        );
        return;
      case "error":
        // Terminal: the platform closes the socket after sending this, so the
        // reason has to be logged here or it is lost to a bare close event.
        this.logger.error(`platools platform error: ${message.error}`);
        return;
    }
  }

  private async dispatchCall(ws: WsLike, call: ToolCallMessage): Promise<void> {
    const tool = this.registry.get(call.tool_name);
    if (tool === undefined) {
      const error: ToolErrorMessage = {
        type: "tool_error",
        call_id: call.call_id,
        error: `unknown tool: ${call.tool_name}`,
      };
      ws.send(encodeSdkMessage(error satisfies SdkToPlatform));
      return;
    }

    // ── Pop the Platos envelopes BEFORE the user handler sees them.
    //
    // The platform injects TWO sub-objects into `params`:
    //   - `__platos` — the signed (organizationId, projectId,
    //     environmentId, entityId, userId, userToken?, agentId,
    //     threadId, callId, timestamp, signature) tuple. Used by the
    //     AsyncLocalStorage frame that powers `currentContext()`.
    //   - `_context` — the CTX.2 per-handler envelope built from
    //     `contextMapping.envelopeKeys` (e.g. `user.id`, caller-
    //     declared `entity_ids` for matrix routing). Exposed to the
    //     handler as the optional second argument.
    // See `apps/agent/src/tool-gateway/tool-executor.service.ts`.
    //
    // Both are stripped before Zod validation so neither leaks into
    // the handler's typed input.
    const rawParams: Record<string, unknown> = { ...call.params };
    const envelopeRaw = rawParams["__platos"];
    const contextEnvelopeRaw = rawParams["_context"];
    // Use `delete` over spread so the original message object isn't
    // mutated (it's shared with the decode step).
    delete rawParams["__platos"];
    delete rawParams["_context"];
    // PPR-29/30: the server now always injects `callId` into the envelope
    // (tool-executor.service.ts). `envelopeToContext` is strict — returns
    // `null` if any required field is missing, matching Python's
    // `current_context()` semantics. No fallback synthesis.
    const platosContext = envelopeToContext(envelopeRaw);

    const start = Date.now();
    try {
      const parsed = tool.inputZodSchema.parse(rawParams);
      // CTX.5: build the handler-facing `PlatosContext` from the
      // popped `_context` envelope (or `{}` if the server didn't
      // send one — older agent / unit-test path). `callId` comes
      // from the outer wire frame so it's always populated.
      const ctx = buildPlatosContext(call.call_id, contextEnvelopeRaw ?? {});
      // When the envelope is missing (older backend / unit tests),
      // fall through without an AsyncLocalStorage frame — accessors
      // return undefined, which matches the documented behavior for
      // "called outside a tool dispatch".
      const result = platosContext === null
        ? await tool.handler(parsed, ctx)
        : await runWithContext(platosContext, () => tool.handler(parsed, ctx));
      const latencyMs = Date.now() - start;
      const resultMessage: ToolResultMessage = {
        type: "tool_result",
        call_id: call.call_id,
        result,
        latency_ms: latencyMs,
      };
      ws.send(encodeSdkMessage(resultMessage satisfies SdkToPlatform));
    } catch (err) {
      const errorMessage: ToolErrorMessage = {
        type: "tool_error",
        call_id: call.call_id,
        error: formatError(err),
        traceback: err instanceof Error && err.stack !== undefined ? err.stack : undefined,
      };
      ws.send(encodeSdkMessage(errorMessage satisfies SdkToPlatform));
    }
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}
