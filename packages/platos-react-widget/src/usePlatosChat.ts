import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlatosClient } from "@platosdev/client";
import type { PerTurnOptions, VisitorIdentity } from "./types.js";

/**
 * Chat-thread state machine:
 *   idle → connecting → ready
 *                     → error
 *   ready → streaming → ready (after `done`)
 */
export type ChatStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "streaming"
  | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** True while the assistant message is still being streamed. */
  streaming?: boolean;
}

export interface UsePlatosChatArgs {
  baseUrl: string;
  agentId: string;
  sessionToken?: string;
  tokenUrl?: string;
  identity?: VisitorIdentity;
  perTurn?: PerTurnOptions;
  onError?: (err: Error) => void;
}

export interface UsePlatosChatResult {
  status: ChatStatus;
  messages: ChatMessage[];
  send: (text: string) => Promise<void>;
  abort: () => void;
  reset: () => void;
  threadId: string | null;
  error: Error | null;
}

/**
 * Headless chat hook — owns the PlatosClient instance, the thread, the
 * message list, and the streaming loop. Call `send(text)` to push a turn;
 * the hook updates `messages` token-by-token through the stream.
 *
 * Most consumers use `<PlatosFab>` which wraps this hook in a UI. Reach
 * for the hook directly when you need a fully custom layout (inline chat,
 * sidebar panel, multi-pane app, etc.).
 */
export function usePlatosChat(args: UsePlatosChatArgs): UsePlatosChatResult {
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const clientRef = useRef<PlatosClient | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const tokenFetchInFlightRef = useRef<Promise<string> | null>(null);

  // Stable token-fetcher used by both initial mint + onTokenRefresh hook.
  const fetchToken = useCallback(async (): Promise<string> => {
    if (args.sessionToken) return args.sessionToken;
    if (!args.tokenUrl) {
      throw new Error(
        "PlatosFab: either `sessionToken` or `tokenUrl` is required",
      );
    }
    if (tokenFetchInFlightRef.current) return tokenFetchInFlightRef.current;
    const p = (async () => {
      const res = await fetch(args.tokenUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: args.identity?.name,
          email: args.identity?.email,
          verified: args.identity?.verified,
        }),
      });
      if (!res.ok) {
        throw new Error(
          `tokenUrl ${args.tokenUrl} returned ${res.status} ${res.statusText}`,
        );
      }
      const body = (await res.json()) as { token?: string };
      if (!body.token) throw new Error("tokenUrl response missing { token }");
      return body.token;
    })();
    tokenFetchInFlightRef.current = p;
    try {
      return await p;
    } finally {
      tokenFetchInFlightRef.current = null;
    }
  }, [
    args.sessionToken,
    args.tokenUrl,
    args.identity?.name,
    args.identity?.email,
    args.identity?.verified,
  ]);

  // Build / rebuild the PlatosClient when auth inputs change. Memoised so
  // the same client instance is reused across renders.
  const ensureClient = useCallback(async (): Promise<PlatosClient> => {
    if (clientRef.current) return clientRef.current;
    const token = await fetchToken();
    const client = new PlatosClient({
      baseUrl: args.baseUrl,
      sessionToken: token,
      onTokenRefresh: args.tokenUrl ? fetchToken : undefined,
    });
    clientRef.current = client;
    return client;
  }, [args.baseUrl, args.tokenUrl, fetchToken]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    clientRef.current = null;
    setStatus("idle");
    setMessages([]);
    setThreadId(null);
    setError(null);
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      setError(null);
      const userMessage: ChatMessage = {
        id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: "user",
        content: text,
      };
      const assistantId = `a_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setMessages((prev) => [
        ...prev,
        userMessage,
        { id: assistantId, role: "assistant", content: "", streaming: true },
      ]);

      try {
        setStatus("connecting");
        const client = await ensureClient();
        // Lazy-create the thread on the first turn so an unsent visitor
        // doesn't pollute the agent's thread list.
        let tid = threadId;
        if (!tid) {
          const thread = await client.threads.create(undefined, {
            agentId: args.agentId,
          });
          tid = thread.id;
          setThreadId(tid);
        }
        setStatus("streaming");
        const ac = new AbortController();
        abortRef.current = ac;

        for await (const event of client.threads.send(
          tid,
          text,
          {
            agentId: args.agentId,
            dynamicBlocks: args.perTurn?.dynamicBlocks,
            modelLabel: args.perTurn?.modelLabel,
            contextType: args.perTurn?.contextType,
            contextId: args.perTurn?.contextId,
            attachmentIds: args.perTurn?.attachmentIds,
            signal: ac.signal,
          },
        )) {
          if (event.type === "token" && typeof event.text === "string") {
            const chunk = event.text;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: m.content + chunk } : m,
              ),
            );
          } else if (event.type === "error") {
            const msg =
              typeof event.message === "string" ? event.message : "stream error";
            throw new Error(msg);
          } else if (event.type === "done") {
            break;
          }
        }
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, streaming: false } : m,
          ),
        );
        setStatus("ready");
        abortRef.current = null;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setStatus("error");
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, streaming: false, content: m.content || "[error]" }
              : m,
          ),
        );
        args.onError?.(e);
      }
    },
    [
      ensureClient,
      threadId,
      args.agentId,
      args.perTurn?.dynamicBlocks,
      args.perTurn?.modelLabel,
      args.perTurn?.contextType,
      args.perTurn?.contextId,
      args.perTurn?.attachmentIds,
      args.onError,
    ],
  );

  // When the auth inputs change, reset so the next send re-authenticates.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return useMemo(
    () => ({ status, messages, send, abort, reset, threadId, error }),
    [status, messages, send, abort, reset, threadId, error],
  );
}
