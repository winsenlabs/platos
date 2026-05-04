"use client";

/**
 * Theme I.4 — React hooks backed by `@platos/client`.
 *
 * These hooks are a thin ergonomic layer on top of the SDK — they
 * instantiate a `PlatosClient` once (memoised on the auth / baseUrl
 * inputs) and expose it via context, plus a set of per-resource hooks:
 *
 *   - `usePlatosClient()` — access the shared client from context.
 *   - `useAgentStream(threadId, message)` — streams a send() response.
 *   - `useThread(threadId)` — metadata + message list (SWR-backed).
 *   - `useToolResult(callId, events)` — narrows an event stream down
 *     to the single tool-call result.
 *   - `useArtifacts(threadId)` — list of artifacts for a thread.
 *
 * We avoid importing `@platos/client` at the package boundary
 * (peerDependency) so the hooks package stays tiny and consumer apps
 * pin the SDK version themselves.
 */

import { createContext, createElement, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * Duck-typed view of `PlatosClient`. We don't import the SDK directly
 * (peer-dep) — consumer passes the instance via `PlatosProvider`.
 */
export interface PlatosClientLike {
  agents: {
    list: (scope?: unknown) => Promise<unknown[]>;
    get: (id: string, scope?: unknown) => Promise<unknown>;
  };
  threads: {
    create: (scope?: unknown, options?: { agentId?: string; title?: string }) => Promise<unknown>;
    list: (scope?: unknown, query?: { agentId?: string; limit?: number }) => Promise<unknown[]>;
    get: (id: string, scope?: unknown) => Promise<unknown>;
    messages: (id: string, scope?: unknown) => Promise<unknown[]>;
    artifacts: (id: string, scope?: unknown) => Promise<unknown[]>;
    send: (
      threadId: string,
      message: string,
      options?: Record<string, unknown>,
      scope?: unknown,
    ) => AsyncIterable<{ type: string; [k: string]: unknown }>;
  };
}

const PlatosClientContext = createContext<PlatosClientLike | null>(null);

export interface PlatosProviderProps {
  client: PlatosClientLike;
  children: ReactNode;
}

export function PlatosProvider({ client, children }: PlatosProviderProps) {
  return createElement(PlatosClientContext.Provider, { value: client }, children);
}

/** Access the shared `PlatosClient` from context. Throws if missing. */
export function usePlatosClient(): PlatosClientLike {
  const client = useContext(PlatosClientContext);
  if (!client) {
    throw new Error(
      "usePlatosClient: no PlatosClient found in context. Wrap your tree in <PlatosProvider client={...}>.",
    );
  }
  return client;
}

/**
 * Stream events from `client.threads.send`. Returns incremental state
 * for the UI (full token buffer, isStreaming flag, latest event).
 *
 * Pass `null` for either arg to reset — useful for "new conversation"
 * buttons that clear the stream without unmounting the component.
 */
export function useAgentStream(
  threadId: string | null,
  message: string | null,
  options?: { scope?: unknown; agentId?: string },
): {
  events: Array<{ type: string; [k: string]: unknown }>;
  tokens: string;
  isStreaming: boolean;
  error: Error | null;
  cancel: () => void;
} {
  const client = usePlatosClient();
  const [events, setEvents] = useState<Array<{ type: string; [k: string]: unknown }>>([]);
  const [tokens, setTokens] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!threadId || !message) {
      setEvents([]);
      setTokens("");
      setIsStreaming(false);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let cancelled = false;
    setEvents([]);
    setTokens("");
    setError(null);
    setIsStreaming(true);
    (async () => {
      try {
        const iter = client.threads.send(
          threadId,
          message,
          { ...(options?.agentId ? { agentId: options.agentId } : {}), signal: ctrl.signal },
          options?.scope,
        );
        for await (const ev of iter) {
          // EOBD.87 — guard every state mutation with `cancelled`, not
          // just the top-of-loop break. Without this, an event that
          // arrives between the effect cleanup and the next `await` in
          // the iterator would fire setEvents/setTokens against the
          // NEW run's empty buffer, leaking a stale event from the old
          // message into the new conversation.
          if (cancelled) break;
          setEvents((prev) => (cancelled ? prev : [...prev, ev]));
          if (ev.type === "token" && typeof ev["text"] === "string") {
            setTokens((prev) => (cancelled ? prev : prev + (ev["text"] as string)));
          }
          if (ev.type === "done") break;
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) setIsStreaming(false);
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [client, threadId, message, options?.scope, options?.agentId]);

  return {
    events,
    tokens,
    isStreaming,
    error,
    cancel: () => abortRef.current?.abort(),
  };
}

/** Fetch a thread + its messages. Naive polling — swap in SWR in a follow-up. */
export function useThread(
  threadId: string | null,
  options?: { scope?: unknown },
): {
  thread: unknown;
  messages: unknown[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
} {
  const client = usePlatosClient();
  const [thread, setThread] = useState<unknown>(null);
  const [messages, setMessages] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useMemo(
    () => async () => {
      if (!threadId) return;
      setLoading(true);
      setError(null);
      try {
        const [t, m] = await Promise.all([
          client.threads.get(threadId, options?.scope),
          client.threads.messages(threadId, options?.scope),
        ]);
        setThread(t);
        setMessages(m);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setLoading(false);
      }
    },
    [client, threadId, options?.scope],
  );

  useEffect(() => {
    if (!threadId) {
      setThread(null);
      setMessages([]);
      return;
    }
    void refresh();
  }, [threadId, refresh]);

  return { thread, messages, loading, error, refresh };
}

/**
 * Narrow a stream of `AgentStreamEvent`s to the `tool_result` matching
 * a specific `callId`. Returns `undefined` until the result arrives.
 */
export function useToolResult<T = unknown>(
  callId: string | null,
  events: Array<{ type: string; [k: string]: unknown }>,
): T | undefined {
  return useMemo(() => {
    if (!callId) return undefined;
    for (const ev of events) {
      if (ev.type === "tool_result" && ev["callId"] === callId) {
        return ev["result"] as T;
      }
    }
    return undefined;
  }, [callId, events]);
}

/** List artifacts for a thread. Refreshes on `threadId` change. */
export function useArtifacts(
  threadId: string | null,
  options?: { scope?: unknown },
): {
  artifacts: unknown[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
} {
  const client = usePlatosClient();
  const [artifacts, setArtifacts] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useMemo(
    () => async () => {
      if (!threadId) return;
      setLoading(true);
      setError(null);
      try {
        const list = await client.threads.artifacts(threadId, options?.scope);
        setArtifacts(list);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setLoading(false);
      }
    },
    [client, threadId, options?.scope],
  );

  useEffect(() => {
    if (!threadId) {
      setArtifacts([]);
      return;
    }
    void refresh();
  }, [threadId, refresh]);

  return { artifacts, loading, error, refresh };
}

/**
 * Convenience: derive the concatenated token buffer from a frozen
 * events array. Handy when the UI doesn't track its own string state
 * and just renders from the tail of the event list.
 */
export function useStreamingResponse(
  events: Array<{ type: string; [k: string]: unknown }>,
): { text: string; done: boolean; usage?: Record<string, unknown> } {
  return useMemo(() => {
    let text = "";
    let done = false;
    let usage: Record<string, unknown> | undefined;
    for (const ev of events) {
      if (ev.type === "token" && typeof ev["text"] === "string") text += ev["text"] as string;
      else if (ev.type === "done") {
        done = true;
        if (ev["usage"] && typeof ev["usage"] === "object") usage = ev["usage"] as Record<string, unknown>;
      }
    }
    return { text, done, usage };
  }, [events]);
}
