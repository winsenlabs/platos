# Sessions-Only Dispatch — Design

**Branch:** `sessions-only-dispatch`
**Status:** Design (doc only, no code changed)
**Author:** Opus 4.8 (agent-side mapping)
**Date:** 2026-07-26
**Directive (Tejas, verbatim intent):** "I don't want durable turn. I only want Sessions. The demo works perfectly as a session — do only that."

---

## 0. One-paragraph summary

Today Trigger **Sessions** are driven only inside the dashboard WS gateway (`connections.gateway.ts::tryDispatchSession`), which fires *before* the `TurnDispatchService` chokepoint — so the demo correctly runs on Sessions while every other durable path (SSE controller, Slack/channel) routes through the chokepoint's `triggerDurable` → `platos.agent.durable-turn` TASK. This design **collapses the durable arm of the chokepoint onto Sessions** so that `executionMode === "durable"` ALWAYS means Sessions, for every entry path, and retires the durable-turn task dispatch. The invariant is preserved and strengthened: `resolveMode` stays the sole `durable|direct` decision; "durable" now routes internally to a single session-drive core exposed as two primitives — **streaming** (gateway/SSE) and **collected** (channel) — and **direct (in-process `streamDirect`) is the ONLY fallback.**

---

## 1. Current mechanism map (verified, agent-side)

### 1.1 The two dispatch layers

| Layer | File | Role today |
|---|---|---|
| Gateway (dashboard WS / demo) | `connections/connections.gateway.ts` | Reads mode once (`:626`), tries **session** (`tryDispatchSession :758`) → durable-turn (`tryDispatchDurable :930`) → in-process `executeStreamingTurn` (`:647`). Session fires *before* the chokepoint. |
| Chokepoint | `agent-runtime/turn-dispatch.service.ts` | `resolveMode` (`:165`) is the ONE `executionMode` read. Durable arm = `triggerDurable` (`:202`) → `platos.agent.durable-turn` task, awaited by `awaitDurableRun` (`:403`). **Explicitly excludes sessions** ("session is a gateway-only sub-strategy"). |
| Session task | `trigger-tasks/chat-session.task.ts` | `chat.customAgent({ id: "platos.chat.session" })` (`:145`). Callback into `/internal/chat/stream-turn`. |
| Channel (Slack/Connect/Walle) | `channels/channel-runtime.service.ts` | `handleInbound :619` and `handleAppEvent :967` both call chokepoint `collectTurn` → durable-turn task → post reply to Slack. |

**Net effect:** demo = Sessions (works). SSE controller + Slack = durable-turn task (Slack broken: `AI_InvalidPromptError`, and inconsistent with the demo).

### 1.2 `tryDispatchSession` — the session drive to lift (`connections.gateway.ts:758–920`)

The full, working session-drive that must move to the chokepoint:

1. **Gate** (`:758–790`): `PLATOS_CHAT_SESSIONS === "true"` **AND** `TRIGGER_SECRET_KEY` set **AND** `!replyToMessageId` **AND** `@trigger.dev/sdk/chat`.`AgentChat` loadable **AND** IDOR-gated `conversationService.getOrCreateThread(scope, agentId, threadId)` resolves. `externalId === threadId` (1:1 session↔thread).
2. **Fresh `AgentChat` per message** (`:793–802`), never cached — `endRun()` after each turn kills the inbox, so a cached client appends into a dead run. Fresh instance takes the `sessions.start` idempotent path → spawns a continuation run.
3. **Redis cursor hydrate** (`:807–813`): key `chatsess:cursor:${org}:${project}:${env}:${threadId}` (scope-namespaced, audit L4). `lastEventId = redis.get(cursorKey)` → passed as `session:{ lastEventId }` so `sessions.start` resumes instead of replaying old `.out`.
4. **Run-finalization race guard** (`:815–838`): before send, if a cursor exists, `sessions.retrieve(threadId)` → `runs.retrieve(prevRunId)`, poll up to 20×1s until the prior one-turn run exits (~10s finalize window; an append into a finalizing run's inbox never dispatches).
5. **Drive** (`:839–872`): `new AgentChat({ agent:"platos.chat.session", id:threadId, clientData, session:{lastEventId}, onTurnComplete })` → `chatClient.sendMessage(message)` returns durable `.out` iterable of UIMessageChunks.
6. **Pump `.out` → thread room** (`:862–920`): join `thread:${threadId}`, emit `meta{ durable:true, session:true }`, then a non-awaited IIFE translates each part → `agent_event` frame (`text-delta`→`token`; `data-platos-event`→verbatim; `error`→error), one emit per event, terminal `{type:"done"}`.
7. **Persist cursor** (`:898–909`): after `.out` drains, `cursor = chatClient.session.lastEventId`; `redis.set(cursorKey, cursor, "EX", 30d)`. (The direct-off-client read is the reliable persist; `onTurnComplete` alone was flaky.)

**Reply is NOT produced in the gateway.** The session worker calls back into `/internal/chat/stream-turn` → `executeStreamingTurn`, which owns config/keys/tools/memory/cost/**message persistence**. The gateway only relays `.out`. There is **no collected final text** on this path — it is stream-only.

### 1.3 The session task (`chat-session.task.ts:145–263`) — unchanged target

- `chat.customAgent({ id:"platos.chat.session" })`, auto-discovered via `trigger.config.ts` `dirs`.
- **One turn per run** (`:156–161`): `chat.createSession(payload,{ maxTurns:1, idleTimeoutInSeconds:15, timeout:"1h" })`.
- Sends only `latestUserText(turn.messages)` (`:187`) to the callback — the session's accumulated messages are NOT the model prompt.
- **Callback** (`:199–209`): `POST ${AGENT_API_URL}/api/v1/agent/internal/chat/stream-turn` with `X-Platos-Admin-Token`, body `{ threadId, agentId, message, scope }`. Endpoint `agent.controller.ts:4450` (`internalChatStreamTurn`), admin-token + `adminCallbackScopeOwns` gated → `executeStreamingTurn` (`:4493`) with heartbeat SSE.
- **Manual finalization** (`:224–259`): `chat.endRun()` BEFORE consuming (bare `break` leaves run EXECUTING forever), then `sessions.open(sessionId ?? turn.chatId).out`, append each `toUIChunks(parseSSE(res.body))` chunk, accumulate `fullText`, `turn.addResponse({role:"assistant",parts:[{type:"text",text:fullText}]})` + `turn.done()`. Bypasses `turn.complete()`'s `sessions.pipe()` (wedges runs).

**Collected text availability:** the task accumulates `fullText` internally but only appends to `.out` + `turn.addResponse`; it does NOT return it as run output (unlike `durable-turn.task.ts` returning `DurableTurnOutput.text`). So to feed the channel a collected reply from a session you must read the `.out` stream server-side (which `driveSession` already does — see §3).

### 1.4 The channel path (`channel-runtime.service.ts`) — what a durable turn must return

- `handleInbound :743–757`: `dispatch.collectTurn(agentId,{ scope, message, threadId })` → `reply = result.text.trim()` → `postOutOfHandler(bot, chatThreadId, reply)`.
- `handleAppEvent :1153–1170`: `dispatch.collectTurn(agentId,{ scope, message, threadId })` → `postSlackMessage(botToken, channel, replyThreadTs, reply)`.
- **Needs only `{ text, threadId }`.** `text` → Slack post; `threadId` for a divergence sanity-warn only.
- **No `replyToMessageId`.** Both calls pass only `{ scope, message, threadId }`. The Slack thread ts is `parsed.replyThreadTs`, kept separate for the post-back tail — never threaded into the turn. **The channel therefore does NOT trip the session gate's `replyToMessageId` carve-out.** This is the key enabler.

### 1.5 The chokepoint methods (`turn-dispatch.service.ts`, verified)

- `resolveMode :165` — the single `executionMode` read → `"durable" | "direct"`.
- `triggerDurable :202` — dispatch to `platos.agent.durable-turn` (payload/idem/tags). **To retire from chat dispatch.**
- `streamDirect :263` — in-process `executeStreamingTurn` generator. **The only fallback.**
- `streamTurn :297` — mode-routed: direct → `streamDirect`; durable → `triggerDurable` + `awaitDurableRun` (`:315`), fail-open to `streamDirect`.
- `collectTurn :341` — durable → `triggerDurable` + `awaitDurableRun`; direct → drains `streamDirect` (`:373`). Fail-open on **dispatch** failure only.
- `awaitDurableRun :403` — reads final durable-turn output. **To retire from chat dispatch.**
- `constructor :145` — **no Redis handle today** (must inject).

---

## 2. The two blockers that Sessions does NOT fix (flag loudly)

### 2.1 `AI_InvalidPromptError` is a same-turn tool-result bug, NOT a transport bug

- `loadHistory` (`conversation.service.ts:1424–1494`) returns **text-only** `{role:"user"|"assistant", content:string}`, role-filtered + empty-filtered. **No tool-role / tool-result / tool-approval parts are ever reconstructed into replayed history.** Assembled at `agent.service.ts:5487` (`[system, ...history, user]`).
- BOTH the session path (`/internal/chat/stream-turn`) and the Slack durable-turn path (`/internal/durable-turn`, `agent.controller.ts:4397`) call the **identical** `executeStreamingTurn` → same text-only `loadHistory` → same `agentService.stream`. **There is no history-replay divergence between demo and Slack.**
- Therefore the error arises **inside a single turn's `streamText` multi-step loop** (`agent.service.ts:5776`+) when the model invokes `request_approval` (`:3091`) / a tool whose result the SDK can't serialize into a valid tool-result part for the *next step within the same turn*. The demo "works" because its turns don't invoke the offending tool; the Slack agent's tool config does.

**Conclusion:** moving Slack onto Sessions makes it **consistent with** the demo but does **not** fix `AI_InvalidPromptError`. That is a separate same-turn serialization fix in `agentService.stream`. **This PR must not claim to resolve the Slack failure.** See §6 for the optional coerce and §8 for the NEEDS_TEJAS flag.

### 2.2 The multi-turn SDK bug (`@trigger.dev/sdk` 4.5.4) is worked around, not fixed

Confirmed version `4.5.4` (`apps/agent/package.json:41`). In-code evidence:
- `chat-session.task.ts:150–155`: the canonical warm loop is deaf to `.in` appends on Cloud for `customAgent` (verified 4.5.0 + 4.5.4) → workaround: `maxTurns:1` + `endRun()` + a continuation run per message.
- `:232–236`: `turn.complete()`'s internal `sessions.pipe()` wedges runs → workaround: manual `sessions.open().out.append` + `addResponse` + `done()`.

**Multi-turn today is NOT a warm long-lived session.** Each user message = a fresh continuation run; continuity is carried by (i) the Redis `lastEventId` cursor and (ii) the run-finalization race guard. Real conversation memory comes from `executeStreamingTurn`→`loadHistory` (Postgres). The Trigger session is a **durable per-turn envelope**, not a stateful multi-turn actor. The whole collapse leans on this workaround; it must be preserved intact in the lifted code.

---

## 3. Target design

### 3.1 Guiding shape

Move the `tryDispatchSession` session-drive **out of the gateway** and **into `TurnDispatchService`** (or a `SessionDispatch` helper the chokepoint owns), as one transport-free core with two public primitives:

- **`streamSession`** (streaming) — gateway WS + SSE controller: yields translated `agent_event` frames from the session `.out`.
- **`collectSession`** (collected) — channel: drives the session to the assistant's final message, returns `{ text, threadId, costCents, messageId }`.

`resolveMode` stays `durable|direct`. "durable" now routes internally to sessions. **`streamDirect` (in-process) is the ONLY fallback** — no third durable-turn rung.

```
resolveMode(agent.executionMode)
   ├── "direct"  → streamDirect (in-process)                    [unchanged]
   └── "durable" → driveSession (Trigger Sessions)
                     ├── streaming  → onPart → agent_event frames   (gateway/SSE)
                     └── collected  → accumulate → { text, threadId, costCents, messageId }  (channel)
                     └── unavailable / dispatch-fail → streamDirect  [ONLY fallback]
```

### 3.2 New private core: `driveSession(agentId, ctx, onPart?)`

Lift `gateway :764–920` verbatim, made transport-free:

1. **Gate:** `PLATOS_CHAT_SESSIONS === "true"` + `TRIGGER_SECRET_KEY` + `require("@trigger.dev/sdk/chat").AgentChat` present. **Drop the blanket `replyToMessageId` gate** — handle it at the caller boundary (§3.6).
2. **IDOR-gated threadId** via `conversationService.getOrCreateThread(scope, agentId, ctx.threadId)` — already the chokepoint's pattern (cf. `triggerDurable :211`). `externalId = threadId`.
3. **Cursor hydrate** from Redis (`chatsess:cursor:${org}:${project}:${env}:${threadId}` — **exact same literal** as the gateway on both read and write, so live cursors survive the deploy).
4. **Race-guard wait** (`sessions.retrieve`→`runs.retrieve` poll, 20×1s) — MUST be kept (it is the multi-turn-bug workaround).
5. **Fresh `AgentChat`** (never cached) → `sendMessage(ctx.message)` → iterate `.out`.
6. For each `.out` part: translate (`text-delta`→`token`; `data-platos-event`→verbatim; `error`→error), **invoke `onPart(evt)`** (if provided) AND **accumulate `fullText`** from `text-delta` deltas. If a `data-platos-event` is a `message_persisted`, capture `costCents` + `messageId` from it.
7. **Persist cursor** (`chatClient.session.lastEventId` → `redis.set(..., "EX", 30d)`) after drain.
8. **Return** `{ threadId, text: fullText, costCents, messageId }` when `.out` drains.

**Redis injection:** `TurnDispatchService` has no Redis handle today — add the same Redis client the gateway uses to the constructor (`:145`). Keep the cursor-key literal byte-identical.

**Hard timeout / done-detection:** `.out` terminating (async iterator completion) IS the turn-done signal — the task's `turn.done()` closes `.out`. Wrap the `for await` drain in a hard wall-clock timeout (e.g. `Promise.race` against a 65s–90s timer, comfortably inside the task `timeout:"1h"` but bounding a hung stream). On timeout: abort the iterator, return what `fullText` we have (streaming: emit `error`+`done`; collected: return partial text or throw → caller fails open to direct). This bounds the "warm loop deaf to appends" failure mode if the race guard is ever insufficient.

### 3.3 `streamSession` (gateway + SSE)

```ts
async *streamSession(agentId, ctx): AsyncGenerator<AgentStreamEvent> {
  // driveSession with an onPart that pushes into a queue this generator yields
}
```

- **Gateway `handleMessage`:** replace the `tryDispatchSession` + `tryDispatchDurable` pair (`:634–644`) with a single `dispatch.streamSession(...)`. The room-join + `meta{session:true}` frame + `agent_event` emit tail (`:863–888`, `:911`) **stay in the gateway** — the gateway consumes the generator and emits to `thread:${threadId}` exactly as today. On session-unavailable (gate false / SDK throw / `replyToMessageId` present) the generator yields nothing and the gateway falls through to the existing in-process `executeStreamingTurn` (`:647`).
- **SSE controller `streamTurn` (`:297`):** durable arm swaps `triggerDurable`+`awaitDurableRun` (`:305`, `:315`) for `driveSession`, yielding `meta` then `token` deltas via `onPart`, then `message_persisted`/`done`. Fail-open to `streamDirect` unchanged (`:300`, `:311`).

### 3.4 `collectSession` (channel)

```ts
async collectSession(agentId, ctx): Promise<CollectedTurnResult> {
  const r = await this.driveSession(agentId, ctx /* onPart omitted */);
  return { text: r.text, threadId: r.threadId, costCents: r.costCents ?? 0, messageId: r.messageId };
}
```

- `collectTurn` (`:341`) durable arm swaps `triggerDurable`+`awaitDurableRun` (`:348`, `:356`) for `collectSession`. `driveSession` accumulates `fullText` from `.out` `text-delta`, so the channel gets its reply with **no run-output dependency** (which the `customAgent` run does not expose anyway — §1.3). `costCents`/`messageId` parsed from the `message_persisted` part if present; else `0`/`undefined` (channel only needs `text`).
- **Result:** Slack and dashboard drive the SAME session envelope — byte-identical at the turn level.

### 3.5 Retire the durable-turn task dispatch

- **Stop dispatching** `platos.agent.durable-turn` from the chat chokepoint: `triggerDurable` (`:202`) + `awaitDurableRun` (`:403`) become dead for the chat path (`streamTurn`, `collectTurn`).
- **Remove gateway `tryDispatchDurable` (`:930`)** entirely.
- **Do NOT delete** the `platos.agent.durable-turn` task file or `/internal/durable-turn` endpoint (`agent.controller.ts:4397`) in this PR. Rationale: keep the diff contained + avoid breaking any non-chat caller. **Verify before any later deletion** whether `employee-run` / `subagent` reference the task (they use `executeNonStreamingTurn` directly, not this task — so likely safe, but confirm). Leave them **dormant** with a `// DEPRECATED: chat dispatch now uses Sessions; slated for removal` marker. → **NEEDS_TEJAS decision, see §8.**
- **Fallback ladder becomes two rungs:** session (durable) → direct (in-process). No third rung.

### 3.6 `replyToMessageId` handling

- **Channel:** passes none (§1.4) → flows straight to sessions. No change needed.
- **Gateway sub-thread case** (`replyToMessageId` set): sessions still has no wire concept for sub-thread replies. Keep a **narrow carve-out at the caller boundary** (not a blanket gate inside `driveSession`): when `ctx.replyToMessageId` is present, `streamSession` returns unavailable → the gateway fails open to `streamDirect` (in-process direct), **NOT** to durable-turn. This preserves sub-thread behavior without resurrecting the task. Document it as a known gap ("sub-thread replies run direct, not durable") pending a session sub-thread wire concept.

---

## 4. Multi-turn completion & timeout contract

- **Done signal:** `.out` async-iterator completion (task does `turn.done()` after appending `fullText`).
- **Continuation model (unchanged):** one turn per run; each message = fresh `AgentChat` + continuation run; continuity via Redis `lastEventId` cursor + race guard. Keep verbatim — do NOT attempt the warm long-lived loop (it is the unfixed SDK bug, §2.2).
- **Race guard MUST move into `driveSession`** (it is in the lifted `:815–838` code — keep it). Two Slack messages within the ~10s finalize window hit the same race the gateway guard handles. **Collected channel turns are awaited to `.out` drain and thus naturally serialize per thread**, which *reduces* this risk vs. the streaming gateway.
- **Hard timeout:** wall-clock `Promise.race` around the drain (see §3.2). Bounds a hung stream well inside the task `timeout:"1h"`.

---

## 5. No-regression requirement (LOAD-BEARING)

The working demo session path must remain byte-identical in observable behavior:
- Same `agent_event` frame shapes (`token` / verbatim `data-platos-event` / `error` / terminal `done`), same `meta{ durable:true, session:true }`, same `thread:${threadId}` room, one emit per event.
- Same cursor key literal, same 30d EX, same race guard, same fresh-`AgentChat`-per-message.
- Same `/internal/chat/stream-turn` callback contract (unchanged task file).
- The refactor is a **move**, not a rewrite: `driveSession` is `tryDispatchSession`'s body with the socket-emit replaced by `onPart`. The gateway keeps its emit tail; the channel keeps its Slack post tail.

**Verification (VPS, after compile):** (1) dashboard demo multi-turn still streams + persists; (2) SSE controller durable turn streams; (3) Slack turn now runs a session (check `trigger_runs_list` shows `platos.chat.session`, not `platos.agent.durable-turn`, for the Slack thread) and posts a reply; (4) no durable-turn runs spawned for chat.

---

## 6. `AI_InvalidPromptError` — optional history/tool-result coerce

Moving to Sessions does NOT fix this (§2.1). It is a same-turn `streamText` tool-result serialization issue. **Out of scope for the collapse PR**, but two independent follow-ups:
- **Same-turn coerce (the real fix):** in `agentService.stream` (~`agent.service.ts:5776`, around `request_approval :3091`), ensure every tool invocation that yields a result (or an approval-pending state) serializes to a valid tool-result / tool-call part before the next step. A malformed/empty approval-response part is the likely trigger. This is a separate investigation (use the `investigate` skill) and a separate PR.
- **Defensive history coerce (cheap belt):** `loadHistory` is already text-only so it is not the cause, but a boundary validator that drops any non-`{user|assistant, non-empty string}` message before `agent.service.ts:5487` costs nothing and guards regressions. Optional; not required for the collapse.

**Do not gate the collapse PR on either.** Flag in the PR body: "consistency fix only; `AI_InvalidPromptError` tracked separately."

---

## 7. Ordered commit plan (one logical unit each)

1. **Inject Redis + add `driveSession` core to `TurnDispatchService`** (private, transport-free). Lift `gateway :764–920` logic: gate (minus blanket `replyToMessageId`), IDOR threadId, cursor hydrate, race guard, fresh `AgentChat`, `.out` translate → `onPart` + `fullText` accumulate + `message_persisted` capture, cursor persist, hard timeout. No caller wired yet. Keep cursor-key literal identical.
2. **Add `streamSession` + `collectSession` public primitives** over `driveSession`. Unit-shaped, still no callers switched.
3. **Route `collectTurn` durable arm → `collectSession`** (swap `triggerDurable`/`awaitDurableRun`). Channel now on sessions. Verify `handleInbound`/`handleAppEvent` still get `{ text, threadId }`.
4. **Route `streamTurn` (SSE) durable arm → `streamSession`.** Fail-open to `streamDirect` preserved.
5. **Gateway `handleMessage`: replace `tryDispatchSession`+`tryDispatchDurable` with `streamSession`.** Keep the socket-emit tail + `replyToMessageId` carve-out → direct. Delete `tryDispatchDurable` (`:930`). This is the no-regression-critical commit — verify demo first.
6. **Mark durable-turn dormant.** `// DEPRECATED` markers on `triggerDurable`/`awaitDurableRun` (chat) + the task file + `/internal/durable-turn`. No deletion (pending §8). Grep-confirm no remaining chat dispatch to `platos.agent.durable-turn`.
7. **(Optional, separate PR)** history-coerce belt + open the `AI_InvalidPromptError` same-turn investigation.

Each commit trailer:
```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EJ2P5P9kCF2ihh6YipRmzM
```

---

## 8. Decisions needing Tejas (NEEDS_TEJAS)

1. **Delete vs dormant durable-turn task.** Recommend **dormant** (leave `platos.agent.durable-turn` + `/internal/durable-turn`, stop dispatching, mark DEPRECATED) to keep the diff contained and avoid breaking a non-chat caller. Deletion needs confirmation that `employee-run`/`subagent` don't use it. **Needs Tejas's call on delete-now vs leave-dormant.**
2. **`AI_InvalidPromptError` expectation.** The collapse makes Slack consistent with the demo but does **NOT** fix the error (same-turn `agentService.stream` bug, §2.1/§6). Tejas must know the Slack failure is a **separate** fix so this PR isn't expected to resolve it.
3. **Multi-turn SDK-bug risk (4.5.4, unfixed).** The entire scheme rides the one-turn-per-run + cursor + race-guard workaround. Moving the channel onto it inherits the ~10s finalize race (mitigated: collected turns serialize per thread). Acceptable, but Tejas should acknowledge the dependency on the unfixed SDK bug.

Everything else in the design is **SOUND** and self-contained agent-side.

---

## 9. Anchor index

- Gate + drive to lift: `connections/connections.gateway.ts:758–920`
- Chokepoint host: `agent-runtime/turn-dispatch.service.ts` — `resolveMode:165`, `triggerDurable:202` (retire), `streamDirect:263`, `streamTurn:297`, `collectTurn:341`, `awaitDurableRun:403` (retire), `constructor:145` (inject Redis)
- Session task (unchanged callback target): `trigger-tasks/chat-session.task.ts:145–263`; endpoint `agent-runtime/agent.controller.ts:4450`
- Channel collected callers (`{text,threadId}`, no `replyToMessageId`): `channels/channel-runtime.service.ts:743–757`, `:1153–1170`
- History (text-only, shared, not the InvalidPrompt cause): `memory/conversation.service.ts:1424–1494`; assembled `agent-runtime/agent.service.ts:5487`; same-turn suspect `agent.service.ts:5776`+ / `request_approval:3091`
- Durable-turn task to leave dormant: `platos.agent.durable-turn`; endpoint `agent.controller.ts:4397`
