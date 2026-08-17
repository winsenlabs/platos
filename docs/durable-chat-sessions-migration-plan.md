# Durable chat → Trigger Sessions migration plan

**Status:** DECIDED 2026-07-16 → **Option B (full `chat.agent` Sessions re-platform)**. Accepts Trigger-Cloud dependence for durable chat (consistent with the durable-exec-on-Cloud direction); self-hosters fall back to direct mode. Execution is phased (skeleton → loop → tools → persistence → frontends) — see "Execution phases (Option B)" at the bottom.
**Author:** session 2026-07-16
**Trigger:** the durable-chat relay double-emits run events (RunsBridge `:136-137` fires two separate `.to().emit()`s to scope+thread rooms; a client in both rooms renders every event twice). Root cause is that we *hand-roll* the streaming transport. "The real fix" = stop hand-rolling it and use Trigger's native durable-chat stack.

---

## What we have now (Variant A — thin-shell relay)

```
WS client ──(socket.io "message")──▶ gateway.tryDispatchDurable
   │                                     ├─ trigger platos.agent.durable-turn
   │                                     ├─ client.join(thread room)
   │                                     └─ RunsBridge.subscribe(runId)
   │
durable-turn.task ──POST /internal/durable-turn──▶ executeStreamingTurn (in-agent)
                                                     ├─ Redis "overview:event" ──▶ gateway forwarder ──▶ thread room
                                                     └─ RunsBridge run_update ──▶ scope room + thread room  ← DOUBLE EMIT BUG
```
Hand-rolled pieces: room registry, per-room auth, heartbeats, reconnect/resume, event framing, stop signal, run-status relay. Every one is a place to get a bug like the double-emit.

## What Trigger v4.5.0 gives us (GA, and we're already on 4.5.0 + AI SDK v7 — verified importable)

Two native paths, different depths:

| | **Path A — Realtime Streams** | **Path B — `chat.agent` / Sessions** |
|---|---|---|
| Writer | `streams.define<UIMessageChunk>()` + `.pipe(result.toUIMessageStream())` inside a task | `run: ({messages,signal}) => streamText({...chat.toStreamTextOptions(), ...})` — auto-piped |
| Reader | `useRealtimeStream(stream, runId, {accessToken})` | Vercel `useChat({transport})` + `useTriggerChatTransport` (`@trigger.dev/sdk/chat/react`) |
| Scope | **run-scoped** (ephemeral, lives inside one run) | **session-scoped** (durable identity `chatId`, many runs, survives refresh/redeploy/crash) |
| Auth | server-minted PAT scoped to runId | server-minted PAT scoped to `read/write:{sessions:chatId}` — the token *is* the room |
| Tool/HITL events | manual (`.type === "tool-call"` …) | first-class `UIMessageChunk` parts + `tool-approval-request` chunks, rendered by `useChat` |
| Transport | Electric SQL + HTTP streaming | S2 (`.in`/`.out`) + S3 snapshot + engine CRIU checkpoint |
| **Self-hostable?** | **Yes** — `baseURL` points at own instance; Electric+HTTP are OSS | **UNDOCUMENTED** — depends on S2 (s2.dev, external) + S3; OSS-webapp availability unstated → **assume Cloud-dependent** |
| Loop location | stays in-agent (task can pipe an in-agent stream via `target: runId`) | **moves into the Trigger worker** (`chat.agent`), or `chat.customAgent` with tool-callbacks |

## The fork (this is the decision)

**Option A — Native Realtime Streams, keep our loop + thread model.** Replace the RunsBridge/Redis/Socket.io *streaming relay* with a Trigger Realtime Stream per durable turn. Gateway mints a run-scoped PAT, hands `{runId, token}` to the client, client subscribes via `useRealtimeStream`. Kills the double-emit + retires the whole relay. **Self-hostable. Incremental. Low risk.** Does NOT deliver durable *sessions* (no cross-run resume, no survive-redeploy-mid-stream, no free HITL streaming). Frontend change is contained (durable turns switch transport; direct turns can stay on socket.io during transition).

**Option B — Full `chat.agent` Sessions (the "real" durable chat).** Loop runs as a `chat.agent`/`chat.customAgent` task; durable cross-run sessions; resume-on-refresh/redeploy; native tool-approval streaming; `useChat` + `useTriggerChatTransport` frontend. This is the complete product. Costs: (1) **loop-in-worker** — either deploy the agent runtime into Trigger, or use `chat.customAgent` and call back for tools/memory/cost/scope (large plumbing); (2) **S2/S3 → likely Trigger-Cloud-dependent** for durable chat (self-hosters fall back to direct mode — consistent with our decided "durable-exec-on-Cloud" direction); (3) **frontend transport rewrite** across dashboard chat + `platos-embed` + `platos-react-widget` (all currently socket.io).

**Recommended:** **A now, B as the north star.** Option A is the honest fix for *this* bug and the relay rot, keeps Platos self-hostable, and is a clean stepping stone. Commit to B as a deliberate, separately-scoped re-platform once we accept the Cloud-dependence + budget the frontend rewrite. (The `durable-turn.task.ts` header already anticipates exactly this as "Variant B".)

## Open verification items before building B
- Self-hosted S2/S3 provisioning for `chat.agent` — is it possible at all on the OSS webapp, or Cloud-only? (Decides whether B breaks self-host durable chat.)
- Frontend blast radius: `useTriggerChatTransport` assumes Next/React server actions for token mint + session start — map onto Remix loaders/actions + the embed/widget SDKs.
- How Platos's per-turn concerns (scope guard, BYOK provider keys, cost ledger, memory extraction, MCP tools, approvals) attach when the loop is a `chat.agent` task vs. our current in-agent `executeStreamingTurn`.

## Phase A implementation sketch (if A is chosen)
1. `apps/agent/src/streams.ts`: `export const turnStream = streams.define<UIMessageChunk>({ id: "agent-turn" })`.
2. In `executeStreamingTurn` (or the durable-turn callback), `turnStream.pipe(result.toUIMessageStream(), { target: runId })` instead of publishing to Redis `overview:event`.
3. Gateway: on durable dispatch, use the run-scoped `publicAccessToken` returned by `tasks.trigger()`, then emit `{type:"meta", runId, streamToken}` to the client.
4. Client (dashboard first): subscribe with `useRealtimeStream(turnStream, runId, {accessToken, baseURL})`; render `parts`.
5. Delete the RunsBridge run_update relay for durable turns (the double-emit source) — or, if kept for non-durable run status, collapse `:136-137` into one chained `.to(scope).to(thread).emit()`.
6. Keep direct-mode turns on socket.io until a later unification pass.

---

## Execution phases (Option B — CHOSEN)

**Architecture (CORRECTED 2026-07-16 — Trigger is server-side ONLY; Platos proxies):** a 3rd party only ever touches **Platos**, never our Trigger. So the browser does NOT use `useTriggerChatTransport` (that connects the browser straight to Trigger's `/realtime/v1/sessions/:id/out` — pushes a Trigger dependency into the client, defeats the self-hostable purpose). Instead: the client stays on Platos's existing socket; Platos's server starts/continues the Trigger session, **reads the session `.out` stream server-side (`sessions.open(chatId).out.read()`) and forwards chunks over its own transport** — a clean single ordered stream (no double-emit). Trigger provides server-side durability (loop survives restart/redeploy); tenant keys are fetched per-session (never stored in Trigger); the operator needs a Trigger for durable mode, else direct-mode fallback.

```
Platos socket client  ◀──forward .out chunks──  Platos server (proxy/bridge)
      │  "message" (as today)                         │  sessions.open(chatId).out.read()  (server-side)
      ▼                                                ▲
Platos gateway ── start/continue Trigger session ──────┘
      │  basePayload { agentId, scope, chatId }   (NO secrets — not persisted to S3)
      ▼
chat.customAgent "platos.chat.session"  (Trigger worker)
  for await (turn of session):
    ├─ turn 0 continuation → GET history from Platos (/internal/chat/history)   [phase 4]
    ├─ resolve config+BYOK key+tools from Platos (/internal/chat/resolve)       [phase 2/3]
    ├─ streamText({ model, system, messages: turn.messages, tools })            [phase 2]
    │     └─ each tool.execute → POST /internal/execute-tool (agent)            [phase 3]
    ├─ turn.complete(result)  → streams to .out → useChat                       [phase 1]
    └─ persist exchange + cost → POST /internal/chat/persist (agent)            [phase 4]
```

- **Phase 1 — walking skeleton (de-risk transport/deploy/auth).** Minimal `chat.customAgent` with a fixed model (together GLM-5.2). Deploy to Trigger. Prove a message streams end-to-end via the `AgentChat` server driver (no frontend yet). Confirms deploy + session + streaming + worker LLM-key path. ← STARTING HERE
- **~~Phase 2 — port the model/config~~ → REUSE.** Under Option 1 (Platos proxies) the worker does NOT reimplement the loop. It calls the agent, which runs the *existing* `executeStreamingTurn` — config, BYOK key, model resolution all already done there. Worker just relays the resulting event stream into the session `.out`.
- **~~Phase 3 — tools~~ → ALREADY DONE.** `executeStreamingTurn` already dispatches meta-tools + entity/MCP tools. No worker-side tool binding needed.
- **~~Phase 4 — persistence + scope + cost~~ → ALREADY DONE.** `executeStreamingTurn` already persists `PlatosAgentMessage`, writes the cost ledger, enforces scope, and fires memory extraction. Nothing to re-add.
- **Phase 2′ (the real work) — stream the turn into the session.** The `chat.customAgent` worker drives the durable session; per turn it calls an agent endpoint that runs `executeStreamingTurn` and **streams** its events (SSE); the worker writes them to `turn`/`session.out` (durable, resumable). History hydration on continuation uses `turn.setMessages` seeded from the agent (or the agent owns history and the worker passes only the new message).
- **Phase 5 — Platos proxy-bridge (NOT browser→Trigger).** Platos server reads the Trigger session `.out` stream and forwards `UIMessageChunk`s over the *existing* socket to the client. Client stays on Platos's transport — no `useTriggerChatTransport`, no session-scoped PATs in the browser, no frontend transport rewrite (client may need minor framing tweaks to render UIMessageChunk parts). Replace the RunsBridge double-emit relay with this single-stream bridge.
- **Phase 6 — cutover + cleanup.** Flip `executionMode=durable` to route through Sessions; delete `durable-turn.task` + the Redis/RunsBridge relay; fix/keep the direct path.

**Open items:** worker LLM-key provisioning model (per-session pass vs Trigger env); Remix (not Next) transport wiring; self-hosted S2/S3 (durable chat = Cloud-only for now).
