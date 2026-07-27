import { chat } from "@trigger.dev/sdk/ai";
// 4.5.3+: the chat wire types moved to the public /chat subpath (changelog #4218).
import type { ChatTaskWirePayload } from "@trigger.dev/sdk/chat";
import { logger, sessions } from "@trigger.dev/sdk";

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
 * clientData (set by the gateway at session start):
 *   { agentId, threadId, scope: { organizationId, projectId, environmentId,
 *     userId, userToken?, entityId? } }
 *
 * `userToken` is the ONE deliberate exception to the former "non-secret only"
 * rule: it is a SHORT-LIVED (120s) per-user HMAC turn-proof the client mints,
 * not a durable credential. It MUST cross this boundary because the entity
 * tool connector re-verifies it (verifyTurnProof) and Platos cannot regenerate
 * it in the durable worker (the signing secret lives only client-side). Without
 * it, every entity-tool call on the durable path fails turn-proof. `entityId`
 * is the minting-entity hint (Mode 2), carried for the same identity reason.
 */

interface PlatosChatClientData {
  agentId: string;
  threadId: string;
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId: string;
    /** 120s per-user HMAC turn-proof — forwarded to entity tool calls. */
    userToken?: string;
    /** Minting-entity hint (Mode 2). */
    entityId?: string;
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
  let sawDone = false;
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
      // Do NOT break: consume to the server's natural close so the underlying
      // body fully drains (a half-open stream can pin the session .out pipe
      // and with it the whole run). The agent ends the SSE right after done.
      sawDone = true;
    } else if (sawDone) {
      // ignore anything after done (shouldn't happen; server closes)
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
    // ONE TURN PER RUN — the empirically proven configuration (probe passed
    // 2 turns end-to-end). The canonical warm loop is deaf to .in appends on
    // Cloud for customAgent (verified on BOTH 4.5.0 and 4.5.4: the waiting
    // run never receives the next message; it idles to timeout). So: serve
    // exactly one turn, exit via chat.endRun(), and the next message spawns
    // a continuation run (requires the client be constructed hydrated with
    // session:{lastEventId} — the gateway bridge does this, and also waits
    // out the short run-finalization window before sending).
    const session = chat.createSession(payload, {
      signal,
      maxTurns: 1,
      idleTimeoutInSeconds: 15,
      timeout: "1h",
    });

    const AGENT_API_URL =
      process.env.PLATOS_AGENT_HTTP_URL || process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
    const adminToken = process.env.PLATOS_ADMIN_TOKEN;

    for await (const turn of session) {
      const cd = turn.clientData as PlatosChatClientData | undefined;
      if (!adminToken || !cd?.agentId || !cd?.scope) {
        chat.endRun();
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

      const fetchAborter = new AbortController();
      const onTurnAbort = () => fetchAborter.abort();
      turn.signal.addEventListener("abort", onTurnAbort, { once: true });
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/internal/chat/stream-turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Platos-Admin-Token": adminToken },
        body: JSON.stringify({
          threadId: cd.threadId,
          agentId: cd.agentId,
          message,
          scope: { ...cd.scope, agentId: cd.agentId, threadId: cd.threadId },
        }),
        signal: fetchAborter.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        chat.endRun();
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

      // chat.endRun() is the SDK's sanctioned one-turn-per-run exit: the turn
      // finishes normally (onTurnComplete fires), the loop exits instead of
      // going idle, and the NEXT message starts a fresh continuation run.
      // A bare `break` is NOT enough — the customAgent wrapper keeps the run
      // bound to the session (observed live: run stayed EXECUTING forever,
      // deaf to new messages, until maxDuration timed it out).
      chat.endRun();
      try {
        // MANUAL finalization (probe-proven): turn.complete()'s internal
        // sessions.pipe() wedged runs on this stack (trace: pipe span never
        // closes → run pinned EXECUTING to maxDuration). Append chunks to the
        // session .out directly, register the response, turn.done() writes
        // turn-complete. Runs complete in ~14s with this path.
        const out = sessions.open((payload as any).sessionId ?? turn.chatId).out;
        let fullText = "";
        for await (const chunk of toUIChunks(parseSSE(res.body!))) {
          if (chunk.type === "text-delta") fullText += chunk.delta;
          await out.append(chunk);
        }
        await turn.addResponse({
          id: `platos-${turn.chatId}-${turn.number}`,
          role: "assistant",
          parts: [{ type: "text", text: fullText }],
        } as any);
        await turn.done();
        logger.info("chat-session turn done (manual path)", {
          chatId: turn.chatId,
          turn: turn.number,
          chars: fullText.length,
        });
      } finally {
        // Guarantee no lingering socket outlives the turn.
        turn.signal.removeEventListener("abort", onTurnAbort);
        fetchAborter.abort();
      }
      break;
    }
    logger.info("chat-session run() exiting");
  },
});
