# Platos → Control Plane + Trigger Substrate — Refactor Spec

**Status:** Proposed (canonical plan) · **Date:** 2026-07-08 · **Owner:** Tejas

> **TL;DR.** Platos becomes a **self-hostable agent control plane + MCP gateway**. All durable execution moves onto **managed trigger.dev Cloud**. Each agent picks its runtime via a per-agent `executionMode` (`direct` = today's low-latency in-process streaming; `durable` = trigger Session/task, resumable/suspendable, for AI-employees). We **delete the forked trigger internals** (run-engine, run-queue, schedule-engine, vendored SDK/CLI/core), slim the Prisma schema from 120→~52 models, and repoint at the managed API. Ship order is zero-regression-first: default every agent to `direct`, light up `durable` per-agent.

**Locked decisions (do not relitigate):**
1. Substrate = **managed trigger.dev Cloud** (checkpoints/warm-starts/autoscale are Cloud-only; we want them).
2. "Self-hostable" = **the control plane only** (agent platform + MCP gateway). Trigger is a managed dependency, not part of the self-host guarantee.
3. Execution runtime is a **per-`PlatosAgent` choice** (`direct` default). Not a global switch.
4. The refactor is **mandatory**; big-bang rewrite is **forbidden**. Every phase ships.

---

## 1. Target architecture

```
                         ┌───────────────────────────────────────────────┐
   Client (web/SDK/MCP)  │                 PLATOS  (control plane)         │
        │                │  identity + (org,project,env) scope + auth      │
        ▼                │  BYOK vault + per-scope crypto + MessageCrypto   │
   ┌─────────┐  turn     │  MCP GATEWAY  (entities · MCP servers · skills) │
   │ ingress ├──────────▶│  tool registry + HMAC dispatch + BM25 discovery │
   └─────────┘           │  agent def/versioning + prompt assembly + model │
        ▲                │  memory store/retrieval · cost ledger · budgets │
        │ stream         │  dashboard                                      │
        │                └───────┬───────────────────────────────┬────────┘
        │                        │ executionMode == "direct"      │ executionMode == "durable"
        │                        ▼                                ▼
        │                 in-process turn                 tasks.trigger / session.send
        │                 (streamText → client)                   │  HTTP (@trigger.dev/sdk)
        │                                                         ▼
        │                                        ┌────────────────────────────────────┐
        └────────── trigger realtime ◀───────────│      MANAGED TRIGGER.DEV CLOUD      │
                                                  │  durable runs · Sessions · waitpoints│
                                                  │  queues/concurrency · machines/scale │
                                                  │  scheduling · retries · run history  │
                                                  └───────────────┬──────────────────────┘
                                                                  │ tool call needs the gateway
                                                                  ▼  HMAC POST /internal/execute-tool
                                                        back into PLATOS MCP gateway
```

**The line:** *Platos decides **what** an agent is, **who** may run it, and **governs every tool call**. Trigger runs it durably and scales it.* The agent-loop body is **Platos code**; in `durable` mode it executes as/under a trigger task that calls **back** into the gateway for tools.

---

## 2. Principles — using trigger *smartly* (and the anti-goals)

**Smart:**
- **Latency-sensitive interactive chat stays `direct`.** Trigger is for durability, not for adding hops to a snappy turn.
- **Idle is free; size for peak concurrent *active* turns, never conversation count.** (10k conversations ≠ 10k active turns; chat is ~95% idle.)
- **Trigger owns only commodity execution.** Anything differentiated (gateway, tenancy, BYOK, memory, cost) never leaves Platos.
- **Human-in-the-loop = `wait.forToken`; long/autonomous = machines + no timeouts; per-tenant fairness = `concurrencyKey: thread-<id>`.**
- **One brain, two runtimes.** Never fork the turn logic; wrap it.

**Anti-goals (explicitly out):**
- ❌ Moving interactive chat to trigger *by default*.
- ❌ Rebuilding or keeping any forked run engine.
- ❌ Big-bang cutover.
- ❌ Weakening the sacred invariants (§4).

---

## 3. What we CUT — the baggage inventory

| Delete / replace | Path | Why it goes | Replacement |
|---|---|---|---|
| **Run Engine 2.0** | `internal-packages/run-engine` | Forked trigger run lifecycle; managed trigger owns this | managed trigger Cloud |
| **Run queue** | `internal-packages/run-queue` | Forked queue | trigger queues |
| **Schedule engine** | `internal-packages/schedule-engine` | Forked cron | trigger `schedules.task` |
| **Vendored SDK** | `packages/trigger-sdk` (`@platos/sdk`) | Fork of `@trigger.dev/sdk`; can't upstream | **`@trigger.dev/sdk`** (real) |
| **Vendored CLI** | `packages/cli-v3` | Fork of trigger CLI | `trigger.dev` CLI (`npx trigger.dev deploy`) |
| **Vendored core** | `packages/core` | Only used for `ApiClient` (`agent.service.ts:158`) | provided by real SDK |
| **Redis worker** | `packages/redis-worker` | Platos job queue; durable jobs move to trigger | trigger tasks (keep only if a lightweight in-process need survives — **decision**) |
| **Realtime hooks** | `packages/react-hooks` | Trigger realtime react hooks (fork) | `@trigger.dev/react-hooks` (if used) |
| **Worker service** | `docker-compose.platos.yml` `worker:` (agent image, `WORKER_MODE`) | Dequeues from in-repo webapp run engine | managed trigger workers |
| **Webapp-as-platform** | `apps/webapp` run-engine role (`app/runEngine/*`, `/engine/v1/worker-actions/*`) | The webapp *is* the forked trigger platform | managed trigger; webapp's *identity/dashboard* role is the **§9 decision** |
| **68 of 71 trigger runtime models** | `schema.prisma` (`TaskRun`, `Waitpoint`, `TaskQueue`, `BackgroundWorker`, `WorkerDeployment`, `BatchTaskRun`, `TaskSchedule`, …) | No Platos table FKs into any of them | dropped |

**Prisma slim:** 120 models (71 trigger-lineage + 49 Platos) → **~52** (49 Platos + `Organization`/`Project`/`RuntimeEnvironment` re-owned). The 41 cascading FKs from Platos tables already point *only* at those 3 identity tables — so the 68 runtime tables drop **without touching a single Platos FK**. Smaller generated client, faster `generate`, far fewer migrations.

---

## 4. What we KEEP — sacred invariants + Platos-owned surface

**Invariants that MUST survive the refactor** (regression here = failure):
- **Multi-tenant scope** `(organizationId, projectId, environmentId)` on every scoped row + `ScopeGuard` (`apps/agent/src/auth/scope.guard.ts`). Enforced *before* any trigger dispatch and inside every callback (`/internal/*` re-materializes `RequestScope`).
- **Three encryption keys** (`ENCRYPTION_KEY` webapp / `PLATOS_ENCRYPTION_KEY` agent / `PLATOS_MESSAGE_ENCRYPTION_KEY` — the last two must differ). Message bodies stay AES-256-GCM at rest (`MessageCryptoService`); **payloads are encrypted before crossing into trigger and decrypted in-task.**
- **BYOK per-scope**, decrypted in-process only at inference (`scopedEnv.getProviderApiKey`). Never logged, never sent to trigger in clear.
- **`PLATOS_TEST_MODE` never in prod** (`main.ts` boot-crash guard) — do not thread it through any new task path.

**Platos-owned (the moat — none of it moves):** MCP gateway (3 tool families, OAuth scoping, per-tool ACLs, HMAC dispatch, BM25 discovery), tool registry + entity WS handshake, agent config/versioning/canary, prompt assembly + model routing, memory store/retrieval + KG, cost ledger + budgets + evals, dashboard.

---

## 5. The turn execution model — one brain, two runtimes

The turn is already a self-contained `AsyncGenerator` explicitly built to be task-wrapped: `AgentTaskService.executeStreamingTurn` (`apps/agent/src/agent-runtime/agent-task.service.ts:82`), which yields straight from `AgentService.stream` (`agent.service.ts:4442`). The Vercel AI SDK's `streamText` (`agent.service.ts:5702`) owns the model→tool→feed loop (`stopWhen: stepCountIs(maxSteps)`). **Execution mode is a wrapper choice, not a fork.**

**New field** on `PlatosAgent` (+ snapshot in `PlatosAgentVersion`, canary-able):
```prisma
enum PlatosExecutionMode { DIRECT DURABLE }
// PlatosAgent
executionMode  PlatosExecutionMode @default(DIRECT)
```

**Dispatch branch** — the single switch point is where the turn is driven:
- WS: `ConnectionsGateway.handleMessage` (`connections.gateway.ts:502`, the `for await (event of executeStreamingTurn) client.emit("agent_event", …)`).
- SSE/REST: `agent.controller.ts:652,946` (→ `streamingService.streamToSSE`).

```ts
if (agent.executionMode === "DIRECT") {
  // TODAY'S PATH — unchanged. In-process generator → Socket.io/SSE. Lowest latency.
  for await (const ev of agentTask.executeStreamingTurn(...)) emit(ev);
} else {
  // DURABLE — hand off to trigger; subscribe to realtime; bridge to client.
  const handle = await tasks.trigger("platos.agent.durable-turn", payload, {
    concurrencyKey: `thread-${threadId}`,            // per-thread serialization
    idempotencyKey: `turn-${threadId}-${clientMsgId}`,
  });
  // RunsBridgeService already forwards runs.subscribeToRun(handle.id) → thread room
}
```

| | `direct` (default) | `durable` |
|---|---|---|
| Runtime | in-process, `streamText` → client | trigger Session/task |
| Latency | unchanged | +dispatch + warm-start (100–300ms Cloud) + realtime hop; +callback per tool |
| Survives crash/redeploy | no (stream lost on drop) | **yes**, resumes mid-stream |
| Human-in-loop | fragile 5-min Redis block | native `wait.forToken` |
| Scale mechanism | horizontal agent instances (§10 P2) | trigger machines + autoscale |
| For | chat, copilots, support | AI-employees, autonomous, scheduled |

**The durable shell already ships** as `agent_batch` (`trigger-tasks/agent-batch.task.ts`): a task in a separate worker that runs a turn via HMAC callback `POST /internal/batch-turn` (`internal-execute-tool.controller.ts:192`) and streams progress via `metadata.set` → `runs.subscribeToRun` → `RunsBridgeService` (`runs-bridge.service.ts:116-141`) → Socket.io. **We generalize this batch/non-streaming precedent to streaming.** Two sub-variants (phase former → latter):
- **(A) thin shell** — task calls the turn *back into Platos* (reuses in-process gateways/meta-tools). Ships fast; Platos still runs the loop.
- **(B) run-in-worker** — `executeStreamingTurn` executes *inside* the trigger worker for true compute offload/autoscale (worker holds DB/Redis; calls back only for entity tools). The real 10k-durable target.

---

## 6. Trigger task inventory — what to write / keep / change

All tasks import **real `@trigger.dev/sdk`**, live under `apps/agent/src/trigger-tasks/` (`trigger.config.ts:23` already declares `dirs`), deploy to the managed project via `trigger.dev deploy`.

**Keep + redeploy to managed (already exist):** `platos.compaction`, `platos.cost.reconcile`, `platos.memory.extract` (cron `0 * * * *`), `platos.budget.alert`, `attachment-retention`, `approvals-expiry-sweep`, `eval-sample`, `litellm-cost-refresh`, `observability-dlq-drain`, `agent-scheduled-run`. Change: `@platos/sdk` → `@trigger.dev/sdk`; secrets/URLs point at managed.

**New / generalized (write these):**

```ts
// 1) Durable interactive/AI-employee turn — generalizes agent_batch to streaming.
export const durableTurn = task({
  id: "platos.agent.durable-turn",
  machine: "small-2x",
  run: async (p: DurableTurnPayload) => {
    // Phase 3 (A): HMAC POST /internal/streaming-turn, pipe AgentStreamEvents → stream/metadata
    // Phase 4 (B): run executeStreamingTurn in-worker; entity tools → /internal/execute-tool
  },
});

// 2) Session-per-thread (durable conversation channel). Option: use chat.agent directly.
export const agentSession = chat.agent({          // externalId = PlatosAgentThread.id
  id: "platos.agent.session",
  run: async ({ messages, signal, ctx }) => { /* delegates to the turn brain */ },
});

// 3) Approval waitpoint — replaces request_approval's 5-min synchronous BLPOP.
//    (agent.service.ts:2713). Existing agent-durable-approval-wait.task.ts is the seed.
const token = await wait.createToken({ timeout: "1h", tags: [`thread:${threadId}`] });
// surface {token.id, token.url} into the PlatosAgentApproval queue; dashboard/API resolves
const decision = await wait.forToken<{ approved: boolean }>(token);
if (!decision.ok || !decision.output.approved) { /* reject branch */ }

// 4) AI-employee workflow runner — long/multi-step autonomous work (machines, no timeout).
export const employeeRun = task({
  id: "platos.agent.employee-run",
  machine: "medium-1x",
  run: async (p: EmployeeRunPayload) => { /* orchestrate sub-turns, tools, waitpoints */ },
});
```

**Callback endpoints (Platos side, HMAC via `TRIGGER_INTERNAL_SECRET`):** existing `POST /internal/execute-tool` (entity tools — full gate stack) and `POST /internal/batch-turn`. **Add** `POST /internal/streaming-turn` (streams events back) and, if meta-tools stay in-process for variant (A), `POST /internal/execute-meta-tool`.

---

## 7. Durable data model — thread ⇄ Session

`PlatosAgentThread.id` (`schema.prisma:3286`) is a stable server-minted cuid, already the canonical key and already flows through the turn as `scope.sessionId` (`agent-task.service.ts:318`) / `(scope as any).threadId` (skill path). **Maps 1:1 to a trigger Session `externalId`.** The durable channel *is* the `PlatosAgentMessage` stream keyed by `threadId`; **one trigger run = one Platos turn.**

Work items:
- **Formalize `threadId` on `RequestScope`** (`scope.guard.ts:46`) — one authoritative source, kill the `as any` casts.
- **Caller-supplied id gap:** `createThread` (`conversation.service.ts:160`) never accepts an id (`@default(cuid())`). To let a caller pre-declare a Session, add optional `id`. Else derive `externalId` from the Platos-minted id (session exists only after turn 1).
- **Context-window hardening (the long-session pressure point):** default `rolling` mode replays only last `contextLimit` (20) msgs + optional Haiku `compactedSummary` — lossy. For durable long-lived sessions: default durable agents to `historyMode:"compact"`, raise `contextLimit`, and/or push durable context into `sessionContext`/memory rather than message replay.
- Concurrency: today's Redis per-thread mutex (`agent-task.service.ts:255`) → trigger `concurrencyKey: thread-<id>` (drop the Redis mutex for durable agents; keep for direct).

---

## 8. The hard parts (and the fix for each)

| Hard part | Evidence | Fix |
|---|---|---|
| **Entity tool WS gateway can't move** — entities hold live WS to the agent process (`ToolSyncWsService` in-process `connections`/`pending` maps, `tool-sync-ws.service.ts:67-68`) | a trigger worker has no access to these sockets | durable turns call **back** via `POST /internal/execute-tool` (`internal-execute-tool.controller.ts:105`) — already covers the full `toolExecutor.execute` gate stack |
| **Local meta-tools are in-process closures** (memory, artifacts, sub-agents, `request_approval`) built in `agent.service.ts:buildMetaTools`; not reachable via `/internal/execute-tool` | invoked by the AI SDK inside `stream()` | variant (A): add `/internal/execute-meta-tool` callback; variant (B): worker has DB/Redis so closures run in-worker |
| **`request_approval` = 5-min synchronous Redis `BLPOP`** (`agent.service.ts:2713`) | blocks a turn; catastrophic in a durable task | convert to `wait.forToken` (task #3, §6) — durable approvals become native |
| **No stream resume/replay today** (SSE + Socket.io both drop post-disconnect events; turn keeps running & billing) | `connections.gateway.ts:311` disconnect only logs | trigger realtime *adds* reconnect-and-catch-up — a net improvement clients adopt |
| **`stop` semantics loose** — key bug (`connections.gateway.ts:733` omits `replyToMessageId` vs set key `:395`); turns survive disconnect | | durable: `runs.cancel(runId)` (`runs-bridge.service.ts:148`). Fix the direct-path key bug in P2 |
| **`agent.service.ts` is 289 KB, loop interwoven with preamble** (`:4442-6012`) | | surgical extraction of the `streamText` unit; do it *with* P3, not as a prereq |

---

## 9. Tenancy / DB slim + webapp fate (parallel track — the real "standalone")

The only thing anchoring Platos to the fork is the **shared Postgres identity spine**. This track is independent of §5–§8 and can run after Phase 1.

- **Keep the 3 identity tables** (`Organization`/`Project`/`RuntimeEnvironment` + `RuntimeEnvironmentType`). Platos already reads+writes them (`admin/environment.service.ts:159/220`, `admin/organization.service.ts:139`). "Re-owning" = drop the trigger-side back-relations to runtime tables; the ~46 injected `platos*[]` relations stay; the 41 Platos FKs already point here.
- **Drop the 68 runtime tables** in one migration. play.platos.dev is a resettable playground → low risk; data-preserving variant for any real deployment.
- **Webapp decision (gate):**
  - **(i) Retire it** → build a minimal Platos console (agents, tools, threads, cost, approvals) + own the end-user login (magic-link/OAuth). Full standalone. Bigger, but sheds the last fork surface.
  - **(ii) Keep it as an identity/console shell** → strip its run-engine role only; it stays the auth + dashboard app. Faster; still carries a Remix fork.
  - Auth is *already* Platos-owned (HMAC session tokens; the agent does not call the webapp to verify) — so (i) is mostly a **dashboard + login-UI** build, not an auth rebuild.

---

## 10. Phased rollout (each phase ships; regression posture explicit)

| Phase | Scope | Regression posture | Proves |
|---|---|---|---|
| **P0 — Substrate seam** | Stand up managed trigger project. Swap `@platos/sdk`→`@trigger.dev/sdk` in `apps/agent`. Deploy the existing tasks to managed. Repoint `TRIGGER_API_URL`/keys (`shared/env.ts:133-140`). Verify compaction/memory/budget/cost run against managed. | **Zero behavior change** (trigger already an optional external client) | Track A works |
| **P1 — Cut execution baggage** | Delete `internal-packages/{run-engine,run-queue,schedule-engine}`, `packages/{trigger-sdk,cli-v3,core}`, the `worker` compose service. Evaluate `redis-worker`. | Zero (nothing in the agent hot path imported them) | the "lighter" payoff |
| **P2 — `executionMode` + direct scaling** | Add the field (+version). Branch dispatch (§5). `direct` = unchanged. **Horizontally scale the agent tier** (Socket.io Redis adapter; already stateless-per-turn). Fix the inline-embedding latency bug + the `stop` key bug. | **Zero** for existing agents; interactive now scales | 10k *conversations* without touching latency |
| **P3 — Durable path (variant A)** | Implement `durable` via thin-shell task (generalize `agent_batch` to streaming) + Session mapping + `request_approval`→`wait.forToken` + meta-tool callback. Flip **pilot** AI-employee agents. | Opt-in per agent; direct untouched | durability where it matters; contains chat.agent maturity risk |
| **P4 — Durable compute offload (variant B)** | Move the loop into the trigger worker (DB/Redis in-worker; entity tools via callback). Autoscale. | Per-agent | true 10k-durable scale |
| **P5 — Tenancy slim + webapp fate** | §9. Drop 68 runtime tables; re-own identity; decide (i)/(ii). | migration-gated | standalone endgame |

**Immediately shippable, zero-regret:** P0 + P1 + P2. They shed the fork and scale interactive chat *before* any durable-turn risk.

---

## 11. Risks & open decisions

- **`chat.agent`/Sessions are ~6 days old (GA 2026-07-02).** Load-test the durable path's ceiling before betting AI-employee workloads at scale. Contained by rolling `durable` out per-agent, latency-insensitive first.
- **Peak concurrent *active* turns is still unpinned** — it sizes the trigger bill ($50/mo vs $2k/mo) and whether P2 alone suffices for a while. **Pin this number.**
- **Data residency:** durable payloads transit trigger. Encrypt-before-`send`, decrypt-in-task must hold the at-rest guarantee. Design in P3.
- **Open decisions:** (a) webapp (i) vs (ii) [§9]; (b) keep or delete `packages/redis-worker` [§3]; (c) `durable` via `chat.agent` primitive vs a hand-rolled `task()` [§6]; (d) caller-supplied thread id [§7].

---

## 12. Appendix — file-level change map

- **Dispatch branch:** `connections.gateway.ts:502` (WS), `agent.controller.ts:652,946` (SSE).
- **Field + versioning:** `schema.prisma` `PlatosAgent` (~`:3011` block) + `PlatosAgentVersion`; `agent-crud.service.ts`.
- **Durable shell precedent:** `trigger-tasks/agent-batch.task.ts`; `internal-execute-tool.controller.ts:105` (`/execute-tool`), `:192` (`/batch-turn`); `runs-bridge.service.ts:116-141,148-162`.
- **Approval:** `agent.service.ts:2713` (BLPOP → `wait.forToken`); `trigger-tasks/agent-durable-approval-wait.task.ts`; `trigger-integration.ts:77-90`.
- **Thread/session:** `conversation.service.ts:160` (add optional id), `:752` (loadHistory), `:618` (storeMessage); `agent-task.service.ts:318` (`sessionId=thread.id`), `:973` (`message_persisted`), `:1235-1297` (compaction), `:1394` (compactIfNeeded); `scope.guard.ts:46` (add `threadId`).
- **SDK/config:** `apps/agent/package.json` (`@platos/sdk`→`@trigger.dev/sdk`), `agent.service.ts:158` (`@platos/core` ApiClient), `trigger.config.ts:23`, `shared/env.ts:133-140`.
- **Crypto:** `monitoring/message-crypto.service.ts` (encrypt-before-send boundary).
- **Baggage:** `internal-packages/{run-engine,run-queue,schedule-engine}`, `packages/{trigger-sdk,cli-v3,core,redis-worker,react-hooks}`, `apps/webapp/app/runEngine/*`, `docker-compose.platos.yml` `worker:`.
- **Schema slim:** drop the 68 runtime models; keep `Organization`/`Project`/`RuntimeEnvironment` (+enum).

**Two CLAUDE.md corrections to make alongside:** `enableThreading` is Slack-style message replies, *not* a per-thread stream multiplex; memory extraction is an hourly cron sweep (`updatedAt`/`turnCount`), *not* a per-turn post-completion job.
