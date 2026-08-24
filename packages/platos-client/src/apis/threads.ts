/**
 * @platosdev/client — threads API + realtime streaming. Theme I.1 + I.3.
 *
 * `send()` is the important one — returns an async-iterable of
 * `PlatosStreamEvent`. Hardening (I.3):
 *
 *   - Manual reconnection loop with exponential backoff. We set
 *     `reconnection: false` on the underlying socket so we can own the
 *     state transitions precisely.
 *   - Events that arrive while we're reconnecting are buffered — never
 *     dropped. `{ type: "reconnecting", retryCount }` is surfaced to the
 *     caller so UIs can show a banner.
 *   - Abort signal tears down the socket and emits a terminal
 *     `{ type: "done", stopped: true }`.
 */

import type { Socket } from "socket.io-client";
import type { PlatosClient } from "../client.js";
import { PlatosNotFoundError } from "../errors.js";
import type {
  PlatosArtifact,
  PlatosMessage,
  PlatosScope,
  PlatosStreamEvent,
  PlatosThread,
  SendMessageOptions,
} from "../types.js";

const DEFAULT_MAX_RECONNECT_RETRIES = 5;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 10_000;

export class ThreadsApi {
  constructor(private readonly client: PlatosClient) {}

  /**
   * Create a new conversation thread. The server mints the id + stores
   * the scope tuple; the returned `thread.id` is what you hand to
   * `send()`.
   */
  async create(
    scope?: PlatosScope,
    options: { agentId?: string; title?: string } = {},
  ): Promise<PlatosThread> {
    return this.client._fetch<PlatosThread>(
      "/api/v1/agent/threads",
      {
        method: "POST",
        body: JSON.stringify({
          agentId: options.agentId ?? "default",
          title: options.title ?? null,
        }),
      },
      scope,
    );
  }

  /** List threads in the current scope. */
  async list(scope?: PlatosScope, query?: { agentId?: string; limit?: number }): Promise<PlatosThread[]> {
    const qs = new URLSearchParams();
    if (query?.agentId) qs.set("agentId", query.agentId);
    if (query?.limit) qs.set("limit", String(query.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const res = await this.client._fetch<{ threads: PlatosThread[] }>(
      `/api/v1/agent/threads${suffix}`,
      { method: "GET" },
      scope,
    );
    return res?.threads ?? [];
  }

  async get(threadId: string, scope?: PlatosScope): Promise<PlatosThread | null> {
    try {
      return await this.client._fetch<PlatosThread>(
        `/api/v1/agent/threads/${encodeURIComponent(threadId)}`,
        { method: "GET" },
        scope,
      );
    } catch (err) {
      if (err instanceof PlatosNotFoundError) return null;
      throw err;
    }
  }

  /** Fetch messages for a thread (F.x paginated). */
  async messages(threadId: string, scope?: PlatosScope): Promise<PlatosMessage[]> {
    const res = await this.client._fetch<{ messages: PlatosMessage[] }>(
      `/api/v1/agent/threads/${encodeURIComponent(threadId)}/messages`,
      { method: "GET" },
      scope,
    );
    return res?.messages ?? [];
  }

  /** Fetch artifacts attached to a thread (F.8). */
  async artifacts(threadId: string, scope?: PlatosScope): Promise<PlatosArtifact[]> {
    const res = await this.client._fetch<{ artifacts: PlatosArtifact[] }>(
      `/api/v1/agent/threads/${encodeURIComponent(threadId)}/artifacts`,
      { method: "GET" },
      scope,
    );
    return res?.artifacts ?? [];
  }

  /** Archive / unarchive / pin toggles. */
  async archive(threadId: string, scope?: PlatosScope): Promise<void> {
    await this.client._fetch<void>(
      `/api/v1/agent/threads/${encodeURIComponent(threadId)}/archive`,
      { method: "POST" },
      scope,
    );
  }

  async unarchive(threadId: string, scope?: PlatosScope): Promise<void> {
    await this.client._fetch<void>(
      `/api/v1/agent/threads/${encodeURIComponent(threadId)}/unarchive`,
      { method: "POST" },
      scope,
    );
  }

  async delete(threadId: string, scope?: PlatosScope): Promise<void> {
    await this.client._fetch<void>(
      `/api/v1/agent/threads/${encodeURIComponent(threadId)}`,
      { method: "DELETE" },
      scope,
    );
  }

  /**
   * Send a message to an agent on a thread and stream the response back
   * as an async iterator of `PlatosStreamEvent`s. The iterator completes
   * when the server emits `{ type: "done" }`, when the caller's
   * `signal` aborts, or when reconnection budget is exhausted.
   */
  async *send(
    threadId: string,
    message: string,
    options: SendMessageOptions = {},
    scope?: PlatosScope,
  ): AsyncGenerator<PlatosStreamEvent, void, void> {
    const maxReconnect = options.maxReconnectRetries ?? DEFAULT_MAX_RECONNECT_RETRIES;
    const queue: PlatosStreamEvent[] = [];
    let waker: (() => void) | null = null;
    let closed = false;
    let terminalError: Error | null = null;

    // Single shared wake helper — resolving the current waker lets the
    // yield loop pop `queue` or observe `closed`.
    const wake = () => {
      if (waker) {
        const w = waker;
        waker = null;
        w();
      }
    };
    const push = (ev: PlatosStreamEvent) => {
      queue.push(ev);
      wake();
    };

    let currentSocket: Socket | null = null;
    let reconnectRetryCount = 0;

    const emitMessage = (sock: Socket) =>
      sock.emit("message", {
        message,
        threadId,
        agentId: options.agentId,
        contextType: options.contextType,
        contextId: options.contextId,
        dynamicBlocks: options.dynamicBlocks,
        attachmentIds: options.attachmentIds,
        sessionContextOverride: options.sessionContextOverride,
        // Per-request model routing: caller selects a named route on the agent.
        ...(options.modelLabel ? { modelLabel: options.modelLabel } : {}),
      });

    // After a reconnect we tell the server which thread we want to
    // resume streaming for. The agent gateway maintains per-thread
    // rooms so it can replay any events we missed during the gap.
    const emitResume = (sock: Socket) =>
      sock.emit("resume_stream", { threadId });

    const attachSocketHandlers = (sock: Socket) => {
      sock.on("agent_event", (ev: PlatosStreamEvent) => {
        push(ev);
        if (ev.type === "done") {
          closed = true;
          sock.disconnect();
          wake();
        }
      });
      sock.on("error", (err: unknown) => {
        // Transport-level error. Treat like a disconnect so we retry
        // reconnection instead of failing hard — many fly/caddy setups
        // surface a transient "error" before "disconnect".
        push({ type: "error", message: err instanceof Error ? err.message : String(err) });
      });
      sock.on("disconnect", (reason: string) => {
        push({ type: "disconnected", reason });
        if (closed) {
          wake();
          return;
        }
        // Kick off reconnect unless the caller aborted or the reason is
        // explicitly client-side (e.g. we called `.disconnect()`).
        if (reason === "io client disconnect" || options.signal?.aborted) {
          wake();
          return;
        }
        void scheduleReconnect();
      });
    };

    const scheduleReconnect = async () => {
      if (closed) return;
      if (reconnectRetryCount >= maxReconnect) {
        terminalError = new Error(`platos-client: exhausted ${maxReconnect} reconnection retries`);
        closed = true;
        wake();
        return;
      }
      reconnectRetryCount += 1;
      const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectRetryCount - 1));
      push({ type: "reconnecting", retryCount: reconnectRetryCount });
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (closed || options.signal?.aborted) return;
      try {
        currentSocket = await this.client._openSocketWithRefresh(scope);
        attachSocketHandlers(currentSocket);
        push({ type: "connected" });
        emitResume(currentSocket);
      } catch (err) {
        terminalError = err instanceof Error ? err : new Error(String(err));
        closed = true;
        wake();
      }
    };

    // Open the first socket through the same refresh-capable auth path as REST.
    currentSocket = await this.client._openSocketWithRefresh(scope);
    attachSocketHandlers(currentSocket);
    push({ type: "connected" });
    emitMessage(currentSocket);

    options.signal?.addEventListener("abort", () => {
      push({ type: "done", stopped: true });
      closed = true;
      currentSocket?.disconnect();
      wake();
    });

    try {
      while (!closed || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (terminalError) throw terminalError;
        if (closed) break;
        await new Promise<void>((resolve) => {
          waker = resolve;
        });
      }
    } finally {
      currentSocket?.disconnect();
    }
  }
}
