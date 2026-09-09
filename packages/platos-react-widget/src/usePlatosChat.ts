import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlatosClient, PlatosRefusal, readWireError } from "@platosdev/client";
import type { PlatosRatingDirection } from "@platosdev/client";
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
  /**
   * Server-side PlatosAgentMessage id, surfaced on the `message_persisted`
   * stream event. Required to rate a message; absent on the provisional
   * client bubble until the turn persists. Only set on assistant messages.
   */
  serverId?: string;
  /** Current local rating: 1 (up), -1 (down), or null/undefined (no vote). */
  rating?: 1 | -1 | null;
  /**
   * The canonical `error.code` when this turn ended in a coded refusal.
   *
   * Present only on an assistant bubble whose turn REACHED the agent and then
   * failed. A turn refused before it got there leaves no bubble at all — see
   * the failure path in `send`.
   */
  refusalCode?: string;
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
  /**
   * Cast a thumbs up/down on an assistant message. Pass the message's local
   * `id`; the hook resolves its `serverId` and calls the rating API. Toggling
   * the same direction again clears the vote (un-rate). Optimistic: updates
   * local `rating` immediately and rolls back on failure. No-op (returns
   * false) if the message has no serverId yet (still streaming / not
   * persisted).
   */
  rate: (messageId: string, direction: PlatosRatingDirection) => Promise<boolean>;
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
  // Mirror of `messages` so `rate()` reads current serverId/rating without
  // re-creating its callback on every token (which would thrash consumers).
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

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
      // WIN-270 (M4.4) — A REFUSAL FROM THE TOKEN ENDPOINT CARRIES ITS CODE.
      //
      // This is the widget's only unauthenticated call, and until this landed it
      // threw `Error("tokenUrl /x returned 401 Unauthorized")` — a sentence, so
      // a host page that wanted to tell "this visitor may not chat" apart from
      // "the mint is down" had to regex HTTP status text. When the endpoint
      // answers ADR M0.4 section 2's envelope the code is now carried through as
      // `PlatosRefusal.code`; when it answers something else the throw names the
      // status and says plainly that there was no code, which is the honest
      // answer for a customer-owned endpoint this SDK does not define.
      const raw = await res.text().catch(() => "");
      let parsed: unknown = null;
      try {
        parsed = raw === "" ? null : JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (!res.ok) {
        const wire = readWireError(parsed);
        throw new PlatosRefusal(
          res.status,
          wire === null
            ? `tokenUrl ${args.tokenUrl} refused with ${res.status} and no error code`
            : wire.title === ""
              ? wire.code
              : `${wire.code}: ${wire.title}`,
          raw,
          (parsed as Record<string, unknown> | null) ?? undefined,
        );
      }
      const body = (parsed ?? {}) as { token?: string };
      // A 2xx WITH NO TOKEN IS A REFUSAL, NOT A SESSION. Returning `undefined`
      // here would construct a `PlatosClient` with no credential and the visitor
      // would see an empty transcript instead of a message.
      if (typeof body.token !== "string" || body.token === "") {
        throw new PlatosRefusal(
          res.status,
          `tokenUrl ${args.tokenUrl} answered ${res.status} with no { token }`,
          raw,
        );
      }
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

      // WIN-270 (M4.4) — DID THE AGENT EVER GET THE TURN?
      //
      // The assistant bubble above is inserted OPTIMISTICALLY, before the token
      // mint and before the thread exists, so that the visitor sees the typing
      // state immediately. That is right while the turn is in flight and wrong
      // once it has been refused: a bubble reading `[error]` is an assistant
      // message the assistant never wrote, and on a refused mint it is a partial
      // answer to a visitor the server declined. So the failure path below
      // distinguishes the two cases, and this flag is the whole distinction.
      let reachedAgent = false;

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
        reachedAgent = true;
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
          } else if (
            event.type === "message_persisted" &&
            typeof (event as { messageId?: unknown }).messageId === "string"
          ) {
            // Stamp the real server message id onto the assistant bubble so
            // rate() can target it. The provisional `assistantId` stays as the
            // React key; `serverId` is what the rating API needs.
            const sid = (event as { messageId: string }).messageId;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, serverId: sid } : m,
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
        setMessages((prev) => {
          // NEVER REACHED THE AGENT: the placeholder is withdrawn. The visitor's
          // own message stays — they did send it — and `error` carries the code.
          if (!reachedAgent) return prev.filter((m) => m.id !== assistantId);
          return prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  streaming: false,
                  content: m.content || "[error]",
                  // The canonical code when the failure was a coded refusal, so
                  // a host that renders its own error UI can branch on it
                  // instead of on the placeholder string.
                  refusalCode: e instanceof PlatosRefusal ? e.code : undefined,
                }
              : m,
          );
        });
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

  const rate = useCallback(
    async (
      messageId: string,
      direction: PlatosRatingDirection,
    ): Promise<boolean> => {
      const msg = messagesRef.current.find((m) => m.id === messageId);
      if (!msg?.serverId) {
        // Not persisted yet (still streaming) — nothing to rate against.
        return false;
      }
      const dirInt: 1 | -1 = direction === "up" ? 1 : -1;
      const prevRating = msg.rating ?? null;
      // Toggle: re-rating the same direction clears the vote.
      const nextRating: 1 | -1 | null = prevRating === dirInt ? null : dirInt;
      // Optimistic local update.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, rating: nextRating } : m,
        ),
      );
      try {
        const client = await ensureClient();
        if (nextRating === null) {
          await client.messages.unrate(msg.serverId);
        } else {
          await client.messages.rate(msg.serverId, direction);
        }
        return true;
      } catch (err) {
        // Roll back on failure.
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId ? { ...m, rating: prevRating } : m,
          ),
        );
        const e = err instanceof Error ? err : new Error(String(err));
        args.onError?.(e);
        return false;
      }
    },
    [ensureClient, args.onError],
  );

  // When the auth inputs change, reset so the next send re-authenticates.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return useMemo(
    () => ({ status, messages, send, rate, abort, reset, threadId, error }),
    [status, messages, send, rate, abort, reset, threadId, error],
  );
}
