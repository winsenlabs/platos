import { chat, type ChatTaskWirePayload } from "@trigger.dev/sdk/ai";
import { logger } from "@trigger.dev/sdk";

/**
 * Platos durable chat — Trigger Sessions re-platform, Option 1 (Platos proxies).
 * Plan: docs/durable-chat-sessions-migration-plan.md
 *
 * The durable successor to `durable-turn.task.ts` ("Variant B" in its header),
 * CORRECTED for the "3rd parties only ever touch Platos" constraint:
 *
 *   - This `chat.customAgent` owns the durable session (survives restarts,
 *     redeploys, crashes; resumable `.out` stream).
 *   - The turn itself still runs IN THE AGENT via
 *     `POST /internal/chat/stream-turn` (SSE) — so config, BYOK keys, tools,
 *     memory, cost ledger, scope enforcement, and message persistence are all
 *     the EXISTING `executeStreamingTurn` code. Nothing is reimplemented here,
 *     and no provider keys ever live in Trigger.
 *   - Platos reads the session `.out` server-side and forwards chunks to the
 *     chat client over its own socket (the proxy-bridge). The browser never
 *     talks to Trigger.
 *
 * Turn flow: client msg → Platos gateway → session `.in` → this loop →
 * agent SSE (AgentStreamEvents) → UIMessageChunks → `turn.complete()` →
 * durable `.out` → Platos proxy → client.
 *
 * clientData (set by the gateway at session start, non-secret only):
 *   { agentId, threadId, scope: { organizationId, projectId, environmentId, userId } }
 */

interface PlatosChatClientData {
  agentId: string;
  threadId: string;
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId: string;
  };
}

/** Minimal UIMessageChunk shapes we emit (AI SDK v7 wire vocabulary). */
type UIChunk =
  | { type: "start" }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "data-platos-event"; data: Record<string, unknown> }
  | { type: "error"; errorText: string }
  | { type: "finish" };

/** Parse an SSE body into the JSON payloads of its `data:` lines. */
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      for (;;) {
        const sep = buf.indexOf("\n\n");
        if (sep === -1) break;
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            yield JSON.parse(raw);
          } catch {
            // non-JSON data line (comment/heartbeat) — skip
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Convert the agent's AgentStreamEvent SSE into UIMessageChunks.
 * `token` events become one text part; tool/meta/persistence events are
 * forwarded as `data-platos-event` parts so the Platos proxy-bridge can
 * translate them back into the client's existing `agent_event` frames.
 */
async function* toUIChunks(events: AsyncGenerator<any>): AsyncGenerator<UIChunk> {
  const textId = "platos-turn-text";
  let textOpen = false;
  yield { type: "start" };
  for await (const ev of events) {
    const t = ev?.type;
    if (t === "heartbeat") continue;
    if (t === "token") {
      if (!textOpen) {
        textOpen = true;
        yield { type: "text-start", id: textId };
      }
      yield { type: "text-delta", id: textId, delta: (ev.text as string) ?? "" };
    } else if (t === "error") {
      if (textOpen) {
        textOpen = false;
        yield { type: "text-end", id: textId };
      }
      yield { type: "error", errorText: (ev.message as string) ?? "turn failed" };
    } else if (t === "done") {
      break;
    } else {
      // tool_call / tool_result / meta / message_persisted / … — forward
      // verbatim for the proxy-bridge (and future UIs) to interpret.
      yield { type: "data-platos-event", data: ev as Record<string, unknown> };
    }
  }
  if (textOpen) yield { type: "text-end", id: textId };
  yield { type: "finish" };
}

/** Extract the newest user message's text from the accumulated ModelMessages. */
function latestUserText(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((p: any) => (p?.type === "text" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}

export const platosChatSession = chat.customAgent({
  id: "platos.chat.session",
  run: async (payload: ChatTaskWirePayload, { signal }) => {
    const session = chat.createSession(payload, {
      signal,
      idleTimeoutInSeconds: 60,
      timeout: "1h",
    });

    const AGENT_API_URL =
      process.env.PLATOS_AGENT_HTTP_URL || process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
    const adminToken = process.env.PLATOS_ADMIN_TOKEN;

    for await (const turn of session) {
      const cd = turn.clientData as PlatosChatClientData | undefined;
      if (!adminToken || !cd?.agentId || !cd?.scope) {
        await turn.complete({
          toUIMessageStream: () =>
            (async function* (): AsyncGenerator<UIChunk> {
              yield { type: "start" };
              yield {
                type: "error",
                errorText: !adminToken
                  ? "PLATOS_ADMIN_TOKEN not set on the Trigger worker"
                  : "session clientData missing agentId/scope",
              };
              yield { type: "finish" };
            })(),
        });
        continue;
      }

      const message = latestUserText(turn.messages as any);
      logger.info("chat-session turn", {
        chatId: turn.chatId,
        turn: turn.number,
        agentId: cd.agentId,
        threadId: cd.threadId,
        chars: message.length,
      });

      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/internal/chat/stream-turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Platos-Admin-Token": adminToken },
        body: JSON.stringify({
          threadId: cd.threadId,
          agentId: cd.agentId,
          message,
          scope: { ...cd.scope, agentId: cd.agentId, threadId: cd.threadId },
        }),
        signal: turn.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        await turn.complete({
          toUIMessageStream: () =>
            (async function* (): AsyncGenerator<UIChunk> {
              yield { type: "start" };
              yield { type: "error", errorText: `agent turn failed: ${res.status} ${detail.slice(0, 200)}` };
              yield { type: "finish" };
            })(),
        });
        continue;
      }

      await turn.complete({ toUIMessageStream: () => toUIChunks(parseSSE(res.body!)) });
    }
  },
});
