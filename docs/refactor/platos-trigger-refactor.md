# Platos → MCP-Native Control Plane + Trigger Substrate — Refactor Spec

**Status:** Proposed (canonical plan) · **Date:** 2026-07-08 · **Rev 2** (folds in MCP interface, multi-tenancy model, skills-as-tasks, user-defined tasks) · **Owner:** Tejas

> **TL;DR.** Platos becomes an **MCP-native, multi-tenant agent control plane + tool gateway**, with all durable execution on **managed trigger.dev Cloud**. MCP is the primary interface — _inbound_ (drive Platos: build/run/observe agents and tasks) and the _gateway_ (agents get federated tools) — and the scope-pinned **MCP token is the per-tenant boundary**. Each agent picks its runtime per-agent via `executionMode` (`direct` = low-latency in-process streaming; `durable` = trigger Session/task). We **delete the forked trigger internals** (run-engine, run-queue, schedule-engine, vendored SDK/CLI/core), slim Prisma 120→~52 models, and repoint at the managed API. Ship order is zero-regression-first.

**Locked decisions (do not relitigate):**

1. Substrate = **managed trigger.dev Cloud** (checkpoints/warm-starts/autoscale are Cloud-only; we want them).
2. "Self-hostable" = **the control plane only** (agent platform + MCP gateway). Trigger is a managed dependency, not part of the self-host guarantee.
3. Execution runtime is a **per-`PlatosAgent` choice** (`direct` default). Not a global switch.
4. **MCP is the primary interface** (inbound control + outbound gateway); REST stays for back-compat, the dashboard becomes a client of the same surface.
5. Substrate multi-tenancy = **one shared Platos trigger project, logically isolated** (Model A); **BYO-trigger** (Model B) is a later enterprise tier.
6. The refactor is **mandatory**; big-bang rewrite is **forbidden**. Every phase ships.

---

## 1. Target architecture

```
   Humans (dashboard)   AI clients (Winsen brain · Claude · Cursor)
        │                         │
        │  MCP  (scope-pinned token = the tenant boundary) + REST (back-compat)
        ▼                         ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │                     PLATOS  (MCP-native control plane)             │
   │  ── PLATFORM MCP (inbound) ── build/deploy/run/observe agents,     │
   │        trigger tasks, read cost/runs   [/mcp/platform]             │
   │  identity + (org,project,env) scope + auth · BYOK + per-scope crypto│
   │  agent def/versioning/canary · prompt assembly · model routing     │
   │  memory store/retrieval · cost ledger · budgets · evals            │
   │  ── GATEWAY MCP (outbound) ── entities · MCP servers · skills,      │
   │        HMAC dispatch · per-tool ACL · BM25 discovery   [/mcp/*]     │
   └───────┬──────────────────────────────────────────┬────────────────┘
           │ executionMode=="direct"                   │ executionMode=="durable"
           ▼                                           ▼
     in-process turn                          tasks.trigger / session.send
     streamText → client (low latency)                 │  @trigger.dev/sdk
           ▲                                           ▼
           │                        ┌──────────────────────────────────────────┐
           └──── trigger realtime ◀─│         MANAGED TRIGGER.DEV CLOUD         │
                                    │ durable runs · Sessions · waitpoints      │
                                    │ queues/concurrency · machines/autoscale   │
                                    │ scheduling · retries · run history        │
                                    │ tenant isolation: concurrencyKey=org-<id> │
                                    └──────────────┬───────────────────────────┘
                                                   │ tool call → HMAC POST /internal/execute-tool
                                                   ▼   back into the PLATOS gateway
```

**The line:** _Platos decides **what** an agent is, **who** may run it (via the scope-pinned MCP token), and **governs every tool call**. Trigger runs it durably and scales it._ The agent-loop body is **Platos code**; in `durable` mode it executes as/under a trigger task that calls **back** into the gateway for tools.

---

## 2. Principles — using trigger _smartly_ (and the anti-goals)

**Smart:**

- **Latency-sensitive interactive chat stays `direct`.** Trigger is for durability, not for adding hops to a snappy turn.
- **Idle is free; size for peak concurrent _active_ turns, never conversation count.** (10k conversations ≠ 10k active turns; chat is ~95% idle.)
- **Trigger owns only commodity execution.** Anything differentiated (MCP gateway, tenancy, BYOK, memory, cost) never leaves Platos.
- **MCP is the interface.** Everything Platos does is expressible as an MCP call; the token is the tenant boundary.
- **One shared trigger project, logically isolated** (`concurrencyKey`+caps+metering). Physical per-tenant projects only as BYO-trigger enterprise tier.
- **Human-in-the-loop = `wait.forToken`; long/autonomous = machines + no timeouts.**
- **One brain, two runtimes.** Never fork the turn logic; wrap it.

**Anti-goals (explicitly out):**

- ❌ Moving interactive chat to trigger _by default_.
- ❌ N physical trigger projects on day one.
- ❌ Rebuilding or keeping any forked run engine.
- ❌ Big-bang cutover.
- ❌ Weakening the sacred invariants (§4).

---

## 3. What we CUT — the baggage inventory

| Delete / replace                    | Path                                                                                                                             | Why it goes                                             | Replacement                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Run Engine 2.0**                  | `internal-packages/run-engine`                                                                                                   | Forked trigger run lifecycle; managed trigger owns this | managed trigger Cloud                                                              |
| **Run queue**                       | `internal-packages/run-queue`                                                                                                    | Forked queue                                            | trigger queues                                                                     |
| **Schedule engine**                 | `internal-packages/schedule-engine`                                                                                              | Forked cron                                             | trigger `schedules.task`                                                           |
| **Vendored SDK**                    | `packages/trigger-sdk` (`@platos/sdk`)                                                                                           | Fork of `@trigger.dev/sdk`; can't upstream              | **`@trigger.dev/sdk`** (real)                                                      |
| **Trigger CLI**                     | Removed from Platos                                                                                                              | No local fork                                           | `trigger.dev` CLI (`npx trigger.dev@latest deploy`)                                |
| **Vendored core**                   | `packages/core`                                                                                                                  | Only used for `ApiClient` (`agent.service.ts:158`)      | provided by real SDK                                                               |
| **Redis worker**                    | `packages/redis-worker`                                                                                                          | Platos job queue; durable jobs move to trigger          | trigger tasks (keep only if a lightweight in-process need survives — **decision**) |
| **Realtime hooks**                  | `packages/react-hooks`                                                                                                           | Trigger realtime react hooks (fork)                     | `@trigger.dev/react-hooks` (if used)                                               |
| **Worker service**                  | `docker-compose.platos.yml` `worker:` (agent image, `WORKER_MODE`)                                                               | Dequeues from in-repo webapp run engine                 | managed trigger workers                                                            |
| **Webapp-as-platform**              | `apps/webapp` run-engine role (`app/runEngine/*`, `/engine/v1/worker-actions/*`)                                                 | The webapp _is_ the forked trigger platform             | managed trigger; webapp's _identity/dashboard_ role is the **§13 decision**        |
| **68 of 71 trigger runtime models** | `schema.prisma` (`TaskRun`, `Waitpoint`, `TaskQueue`, `BackgroundWorker`, `WorkerDeployment`, `BatchTaskRun`, `TaskSchedule`, …) | No Platos table FKs into any of them                    | dropped                                                                            |

**Prisma slim:** 120 models (71 trigger-lineage + 49 Platos) → **~52** (49 Platos + `Organization`/`Project`/`RuntimeEnvironment` re-owned). The 41 cascading FKs from Platos tables already point _only_ at those 3 identity tables — so the 68 runtime tables drop **without touching a single Platos FK**.

---

## 4. What we KEEP — sacred invariants + Platos-owned surface

**Invariants that MUST survive** (regression here = failure):

- **Multi-tenant scope** `(organizationId, projectId, environmentId)` on every scoped row + `ScopeGuard` (`apps/agent/src/auth/scope.guard.ts`). Enforced _before_ any trigger dispatch and inside every callback (`/internal/*` re-materializes `RequestScope`). The **scope-pinned MCP token carries this tuple** (§6c).
- **Three encryption keys** (`ENCRYPTION_KEY` webapp / `PLATOS_ENCRYPTION_KEY` agent / `PLATOS_MESSAGE_ENCRYPTION_KEY` — last two must differ). Message bodies stay AES-256-GCM at rest (`MessageCryptoService`); **payloads are encrypted before crossing into trigger and decrypted in-task.**
- **BYOK per-scope**, decrypted in-process only at inference (`scopedEnv.getProviderApiKey`). Never logged, never sent to trigger in clear.
- **`PLATOS_TEST_MODE` never in prod** (`main.ts` boot-crash guard) — do not thread it through any new task path.

**Platos-owned (the moat — none of it moves):** MCP gateway (3 tool families, OAuth scoping, per-tool ACLs, HMAC dispatch, BM25 discovery), the platform MCP, tool registry + entity WS handshake, agent config/versioning/canary, prompt assembly + model routing, memory store/retrieval + KG, cost ledger + budgets + evals, dashboard.

---

## 5. The turn execution model — one brain, two runtimes

The turn is already a self-contained `AsyncGenerator` explicitly built to be task-wrapped: `AgentTaskService.executeStreamingTurn` (`apps/agent/src/agent-runtime/agent-task.service.ts:82`), yielding from `AgentService.stream` (`agent.service.ts:4442`). The Vercel AI SDK's `streamText` (`agent.service.ts:5702`) owns the model→tool→feed loop (`stopWhen: stepCountIs(maxSteps)`). **Execution mode is a wrapper choice, not a fork.**

**New field** on `PlatosAgent` (+ snapshot in `PlatosAgentVersion`, canary-able):

```prisma
enum PlatosExecutionMode { DIRECT DURABLE }
executionMode  PlatosExecutionMode @default(DIRECT)   // on PlatosAgent
```

**Dispatch branch** — the single switch point where the turn is driven (WS: `ConnectionsGateway.handleMessage` `connections.gateway.ts:502`; SSE/REST: `agent.controller.ts:652,946`):

```ts
if (agent.executionMode === "DIRECT") {
  for await (const ev of agentTask.executeStreamingTurn(...)) emit(ev);  // unchanged, lowest latency
} else {
  const handle = await tasks.trigger("platos.agent.durable-turn", payload, {
    concurrencyKey: `org-${orgId}`,                     // per-tenant fairness (§7)
    idempotencyKey: `turn-${threadId}-${clientMsgId}`,
  });
  // RunsBridgeService forwards runs.subscribeToRun(handle.id) → thread room
}
```

|                         | `direct` (default)                  | `durable`                                                                   |
| ----------------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| Runtime                 | in-process, `streamText` → client   | trigger Session/task                                                        |
| Latency                 | unchanged                           | +dispatch + warm-start (100–300ms Cloud) + realtime hop; +callback per tool |
| Survives crash/redeploy | no (stream lost on drop)            | **yes**, resumes mid-stream                                                 |
| Human-in-loop           | fragile 5-min Redis block           | native `wait.forToken`                                                      |
| Scale mechanism         | horizontal agent instances (§14 P2) | trigger machines + autoscale                                                |
| For                     | chat, copilots, support             | AI-employees, autonomous, scheduled                                         |

**The durable shell already ships** as `agent_batch` (`trigger-tasks/agent-batch.task.ts`): a task in a separate worker that runs a turn via HMAC callback `POST /internal/batch-turn` (`internal-execute-tool.controller.ts:192`) and streams progress via `metadata.set` → `runs.subscribeToRun` → `RunsBridgeService` (`runs-bridge.service.ts:116-141`) → Socket.io. **We generalize this to streaming.** Two sub-variants (phase former → latter):

- **(A) thin shell** — task calls the turn _back into Platos_. Ships fast; Platos still runs the loop.
- **(B) run-in-worker** — `executeStreamingTurn` executes _inside_ the trigger worker for true compute offload/autoscale (worker holds DB/Redis; calls back only for entity tools). The real 10k-durable target.

---

## 6. MCP — the interface to Platos (two surfaces)

Platos is **MCP-native**: MCP is the primary programmatic interface, for humans-via-clients and for agents alike.

### 6a. Platform MCP (inbound — _drive_ Platos)

Exposes control-plane ops as an MCP server (`apps/agent/src/mcp-platform/`, `/mcp/platform`). **Already shipped:** `agents_create/update/get/list/delete`, `agents_deploy_with_skills`, `agents_canary_set/promote`, `agents_census/clone_from`, `threads_create/get/list/update/delete/fork/edit_and_rerun`, `messages_list/rate`, `monitoring_cost_daily/range`, `platos_simulate_turn/explain_turn/diff_agents/whoami/list_accessible_scopes`, `trigger_runs_get/list` (read-only today).

**Add the write surface** so "create tasks on Platos directly" is just an MCP call:

- `tasks_trigger(taskId, payload)` → `tasks.trigger(...)`, scoped by the caller's token.
- `trigger_runs_create` / `trigger_runs_cancel` / `trigger_runs_retry`.
- `skills_run(skillId, input)` → dispatch a skill as a task (§9).

An AI client (Claude, Cursor, **Winsen's own brain**) can then build, deploy, run, observe, and cancel agents + durable tasks entirely over MCP.

### 6b. Gateway MCP (outbound — agents _get_ tools)

The federation surface (entities + MCP servers + skills) exposed to the agents Platos runs, and to any external MCP client on a tenant-scoped endpoint. Crown jewel; role unchanged. Durable trigger tasks reach it via the HMAC callback.

### 6c. The MCP token IS the tenancy boundary

Scope-pinned MCP tokens carry `(org, project, env)`. Every platform-MCP op — including creating task runs — is **automatically tenant-scoped**, and the run inherits `concurrencyKey: org-<id>` + budget caps + cost metering (§7). **Per-account _experience_, shared _substrate_** — this satisfies the "per-account, not one-trigger-for-all" instinct at the interface layer, without N physical projects.

### 6d. The payoff — composable / self-building

An agent running _on_ Platos can, via the platform MCP, create and configure _other_ agents and tasks on Platos. That's the self-revolving meta-model: the company brain doesn't hit a bespoke REST API to spin up an AI employee — it speaks MCP to Platos, and Platos + trigger execute. The dashboard is a thin client over the same surface.

---

## 7. Multi-tenancy on the substrate — one project, logically isolated (BYO-trigger later)

Task _definitions_ are deployed code tied to a trigger project; _runs_ are per-invocation. "A trigger per account" would mean deploying the bundle to N projects with N credential sets — premature physical isolation. Instead:

| Model                                                           | Mechanism                                                                                                                                                                                                                                            | When                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **A — one Platos trigger project (shared, logically isolated)** | `concurrencyKey: org-<id>` (per-tenant fair queues) + per-tenant concurrency/budget caps (reuse `BudgetService`) + scope in run `metadata`/`tags` + per-tenant trigger compute metered into the existing **cost ledger**. Tenants never see trigger. | **Now (default)**          |
| **B — per-tenant "BYO-trigger"**                                | tenant's own trigger project ref + secret stored **encrypted per-scope** — the exact BYOK machinery (`scopedEnv`, per-scope SecretStore). Platos routes their durable runs to their project. Requires their task bundle deployed to their project.   | **Enterprise tier, later** |

**Model B is BYOK for durable execution** — same philosophy, same machinery as provider keys. The per-env-key routing already exists (`RuntimeEnvironment.apiKey`); Model A keeps one Platos key in that slot, Model B swaps in the tenant's. Ship A; offer B when a customer needs runs in their own account / data residency.

---

## 8. Trigger task inventory — ~14 kept + ~5 new ≈ 20

All tasks import **real `@trigger.dev/sdk`**, live under `apps/agent/src/trigger-tasks/` (`trigger.config.ts:23` declares `dirs`), deploy via `trigger.dev deploy` to the shared project.

**Keep + redeploy to managed:** `platos.compaction`, `platos.cost.reconcile`, `platos.memory.extract` (cron `0 * * * *`), `platos.budget.alert`, `attachment-retention`, `approvals-expiry-sweep`, `eval-sample`, `litellm-cost-refresh`, `observability-dlq-drain`, `agent-scheduled-run`, `agent-batch`, `agent-tool-block`, `agent-durable-approval-wait`, `platos-custom-task`. Change: `@platos/sdk` → `@trigger.dev/sdk`; secrets/URLs → managed.

**New / generalized:**

```ts
// 1) Durable interactive/AI-employee turn — generalizes agent_batch to streaming.
export const durableTurn = task({
  id: "platos.agent.durable-turn",
  machine: "small-2x",
  run: async (p: DurableTurnPayload) => {
    // P3 (A): HMAC POST /internal/streaming-turn, pipe AgentStreamEvents → stream/metadata
    // P4 (B): run executeStreamingTurn in-worker; entity tools → /internal/execute-tool
  },
});

// 2) Session-per-thread durable channel (externalId = PlatosAgentThread.id). Option: chat.agent.
export const agentSession = chat.agent({
  id: "platos.agent.session",
  run: async ({ messages, signal, ctx }) => {
    /* delegates to the turn brain */
  },
});

// 3) Approval waitpoint — replaces request_approval's 5-min synchronous BLPOP (agent.service.ts:2713).
const token = await wait.createToken({ timeout: "1h", tags: [`thread:${threadId}`] });
// surface {token.id, token.url} into the PlatosAgentApproval queue; dashboard/API resolves
const decision = await wait.forToken<{ approved: boolean }>(token);

// 4) AI-employee workflow runner — long/multi-step autonomous (machines, no timeout).
export const employeeRun = task({
  id: "platos.agent.employee-run",
  machine: "medium-1x",
  run: async (p: EmployeeRunPayload) => {
    /* orchestrate sub-turns, tools, waitpoints */
  },
});

// 5) Skill runner — heavy/parallel/long skills as tasks (§9). One generic runner + batchTrigger.
export const skillRun = task({
  id: "platos.skill.run",
  machine: "small-1x",
  run: async (p: SkillRunPayload) => {
    /* execute skill; entity/gateway calls via callback */
  },
});
```

Plus the **config-interpreter** custom task (§10) reusing `platos-custom-task`.

**Callback endpoints (Platos side, HMAC via `TRIGGER_INTERNAL_SECRET`):** existing `POST /internal/execute-tool` (entity tools — full gate stack) and `POST /internal/batch-turn`. **Add** `POST /internal/streaming-turn` (streams events back) and, if meta-tools stay in-process for variant (A), `POST /internal/execute-meta-tool`.

---

## 9. Skills as task runs

A skill's `execute` can dispatch to a trigger task instead of running in-process. Highest value for **heavy / parallel / long** skills:

- **`parallel-web` / any fan-out** → `batchTrigger` (up to 1,000 runs/call); the queue's `concurrencyLimit` does the rate-limiting for free.
- **`code_execution`** (E2B, can run long) → a trigger machine, no timeout, off the agent event loop.
- `execute_tools` batching → `batchTrigger` for parallel tool execution.

**Per-skill flag** (like `executionMode`, for skills): run-as-task when heavy/parallel/long, in-process when quick — same latency rule (don't add a hop to a fast skill on a `direct` turn). Bonus: offloads slow skill work off the agent process → directly helps 10k scale. Exposed via the platform MCP as `skills_run`.

---

## 10. User-defined tasks — config, not code

Trigger tasks are **deployed code**; you can't create arbitrary code-tasks at runtime. User-authored durable workflows use a **config-interpreter** pattern: one generic Platos-deployed task reads a user's **workflow config** (steps, tools, schedule) and executes it. `platos-custom-task` (`trigger-tasks/platos-custom-task.ts`) is the seed. This gives tenants "build your own durable agent/workflow" **without a per-tenant deploy pipeline** — the definition is data, the executor is one deployed task, created/triggered via the platform MCP (`tasks_trigger`) and scoped by the MCP token.

---

## 11. Durable data model — thread ⇄ Session

`PlatosAgentThread.id` (`schema.prisma:3286`) is a stable server-minted cuid, already the canonical key and already flows through the turn as `scope.sessionId` (`agent-task.service.ts:318`) / `(scope as any).threadId` (skill path). **Maps 1:1 to a trigger Session `externalId`.** The durable channel _is_ the `PlatosAgentMessage` stream keyed by `threadId`; **one trigger run = one Platos turn.**

Work items:

- **Formalize `threadId` on `RequestScope`** (`scope.guard.ts:46`) — one authoritative source, kill the `as any` casts.
- **Caller-supplied id gap:** `createThread` (`conversation.service.ts:160`) never accepts an id (`@default(cuid())`). To let a caller pre-declare a Session, add optional `id`; else derive `externalId` from the Platos-minted id (session exists only after turn 1).
- **Context-window hardening (long-session pressure point):** default `rolling` replays only last `contextLimit` (20) msgs + optional Haiku `compactedSummary` — lossy. For durable long-lived sessions: default durable agents to `historyMode:"compact"`, raise `contextLimit`, and/or push durable context into `sessionContext`/memory.
- Concurrency: today's Redis per-thread mutex (`agent-task.service.ts:255`) → trigger `concurrencyKey` (drop the mutex for durable agents; keep for direct).

---

## 12. The hard parts (and the fix for each)

| Hard part                                                                                                                                                                         | Evidence                                          | Fix                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Entity tool WS gateway can't move** — entities hold live WS to the agent process (`ToolSyncWsService` maps, `tool-sync-ws.service.ts:67-68`)                                    | a trigger worker has no access to these sockets   | durable turns call **back** via `POST /internal/execute-tool` (`internal-execute-tool.controller.ts:105`) — covers the full `toolExecutor.execute` gate stack |
| **Local meta-tools are in-process closures** (memory, artifacts, sub-agents, `request_approval`) in `agent.service.ts:buildMetaTools`; not reachable via `/internal/execute-tool` | invoked by the AI SDK inside `stream()`           | variant (A): add `/internal/execute-meta-tool`; variant (B): worker has DB/Redis so closures run in-worker                                                    |
| **`request_approval` = 5-min synchronous Redis `BLPOP`** (`agent.service.ts:2713`)                                                                                                | blocks a turn; catastrophic in a durable task     | convert to `wait.forToken` (task #3, §8)                                                                                                                      |
| **No stream resume/replay today** (SSE + Socket.io drop post-disconnect events; turn keeps running & billing)                                                                     | `connections.gateway.ts:311` disconnect only logs | trigger realtime _adds_ reconnect-and-catch-up — a net improvement clients adopt                                                                              |
| **`stop` semantics loose** — key bug (`connections.gateway.ts:733` omits `replyToMessageId` vs set key `:395`)                                                                    |                                                   | durable: `runs.cancel(runId)` (`runs-bridge.service.ts:148`). Fix the direct-path key bug in P2                                                               |
| **Platform-MCP write surface must re-verify scope** — `tasks_trigger` etc. create real runs                                                                                       | MCP token carries scope                           | enforce `ScopeGuard` on the MCP write tools; stamp `concurrencyKey`/`metadata` from the token, never from the payload                                         |
| **`agent.service.ts` is 289 KB, loop interwoven with preamble** (`:4442-6012`)                                                                                                    |                                                   | surgical extraction of the `streamText` unit; do it _with_ P3                                                                                                 |

---

## 13. Tenancy / DB slim + webapp fate (parallel track — the real "standalone")

The only thing anchoring Platos to the fork is the **shared Postgres identity spine**. Independent of §5–§12; runs after Phase 1.

- **Keep the 3 identity tables** (`Organization`/`Project`/`RuntimeEnvironment` + `RuntimeEnvironmentType`). Platos already reads+writes them (`admin/environment.service.ts:159/220`, `admin/organization.service.ts:139`). "Re-owning" = drop the trigger-side back-relations to runtime tables; the ~46 injected `platos*[]` relations stay.
- **Drop the 68 runtime tables** in one migration. play.platos.dev is resettable → low risk; data-preserving variant for real deployments.
- **Webapp decision (gate):** (i) **retire it** → build a minimal Platos console over the platform-MCP/REST surface + own end-user login (magic-link/OAuth); full standalone. (ii) **keep as identity/console shell** → strip only its run-engine role. Auth is _already_ Platos-owned (HMAC session tokens; agent doesn't call webapp to verify), so (i) is mostly a **dashboard + login-UI** build. Because the dashboard becomes an MCP/REST _client_ (§6d), (i) gets cheaper over time.

---

## 14. Phased rollout (each phase ships; regression posture explicit)

| Phase                                                         | Scope                                                                                                                                                                                                                                                                                                                        | Regression                                             | Proves                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| **P0 — Substrate seam + tenant isolation**                    | Stand up managed trigger project. `@platos/sdk`→`@trigger.dev/sdk`. Deploy existing tasks. Repoint `TRIGGER_API_URL`/keys (`shared/env.ts:133-140`). Bake in Model-A isolation from the start: `concurrencyKey: org-<id>` + meter trigger compute into the cost ledger. Verify compaction/memory/budget/cost run on managed. | **Zero** (trigger already an optional external client) | Track A + tenant isolation                                       |
| **P1 — Cut execution baggage**                                | Delete `internal-packages/{run-engine,run-queue,schedule-engine}`, the remaining vendored `packages/{trigger-sdk,core}`, and the `worker` compose service. The vendored Trigger CLI was removed separately in WIN-162. Evaluate `redis-worker`.                                                                              | Zero (agent hot path imports none)                     | the "lighter" payoff                                             |
| **P2 — `executionMode` + direct scaling + MCP write surface** | Add the field (+version). Branch dispatch (§5). `direct` = unchanged. Horizontally scale the agent tier (Socket.io Redis adapter; already stateless-per-turn). Add platform-MCP `tasks_trigger`/`trigger_runs_create/cancel` (§6a). Fix inline-embedding latency + `stop` key bugs.                                          | **Zero** for existing agents                           | 10k _conversations_ at unchanged latency; "create tasks via MCP" |
| **P3 — Durable path (A) + skills-as-tasks + custom tasks**    | `durable` via thin-shell task + Session mapping + `request_approval`→`wait.forToken` + meta-tool callback. Skill runner + per-skill flag (§9). Config-interpreter custom task (§10). Flip **pilot** AI-employee agents.                                                                                                      | Opt-in per agent; direct untouched                     | durability where it matters; offload heavy skills                |
| **P4 — Durable compute offload (B)**                          | Move the loop into the trigger worker; entity tools via callback. Autoscale.                                                                                                                                                                                                                                                 | Per-agent                                              | true 10k-durable scale                                           |
| **P5 — Tenancy slim + webapp fate + BYO-trigger**             | §13 (drop 68 tables, re-own identity, webapp (i)/(ii)). Model B (BYO-trigger enterprise tier, §7).                                                                                                                                                                                                                           | migration-gated                                        | standalone + enterprise isolation                                |

**Immediately shippable, zero-regret:** P0 + P1 + P2. They shed the fork, scale interactive chat, and light up the MCP task surface _before_ any durable-turn risk.

---

## 15. Risks & open decisions

- **`chat.agent`/Sessions are days old (GA 2026-07-02).** Load-test the durable ceiling before betting AI-employee workloads at scale. Contained by rolling `durable` out per-agent, latency-insensitive first.
- **Peak concurrent _active_ turns is unpinned** — sizes the trigger bill ($50 vs $2k/mo) and whether P2 alone suffices for a while. **Pin this number.**
- **Data residency:** durable payloads transit trigger. Encrypt-before-`send`, decrypt-in-task must hold the at-rest guarantee. Design in P3.
- **Open decisions:** (a) webapp (i) vs (ii) [§13]; (b) keep or delete `packages/redis-worker` [§3]; (c) `durable` via `chat.agent` primitive vs hand-rolled `task()` [§8]; (d) caller-supplied thread id [§11]; (e) fully deprecate bespoke REST once MCP-native, or keep co-equal [§6, decision #4 leans MCP-primary + REST-back-compat]; (f) which skills default to task-offload [§9]; (g) Model B (BYO-trigger) timing [§7].

---

## 16. Appendix — file-level change map

- **Dispatch branch:** `connections.gateway.ts:502` (WS), `agent.controller.ts:652,946` (SSE).
- **Field + versioning:** `schema.prisma` `PlatosAgent` (~`:3011`) + `PlatosAgentVersion`; `agent-crud.service.ts`.
- **Durable shell precedent:** `trigger-tasks/agent-batch.task.ts`; `internal-execute-tool.controller.ts:105` (`/execute-tool`), `:192` (`/batch-turn`); `runs-bridge.service.ts:116-141,148-162`.
- **Approval:** `agent.service.ts:2713` (BLPOP → `wait.forToken`); `trigger-tasks/agent-durable-approval-wait.task.ts`; `trigger-integration.ts:77-90`.
- **Thread/session:** `conversation.service.ts:160` (add optional id), `:752` (loadHistory), `:618` (storeMessage); `agent-task.service.ts:318` (`sessionId=thread.id`), `:973` (`message_persisted`), `:1235-1297`/`:1394` (compaction); `scope.guard.ts:46` (add `threadId`).
- **MCP:** `apps/agent/src/mcp-platform/` (add `tasks_trigger`/`trigger_runs_create/cancel`/`skills_run`; enforce `ScopeGuard` on writes); gateway `/mcp/*`.
- **Skills:** `apps/agent/src/skills/` + `skills/official/skill-handlers.ts` (per-skill task-offload flag); `parallel-web`, `code_execution`.
- **SDK/config:** `apps/agent/package.json` (`@platos/sdk`→`@trigger.dev/sdk`), `agent.service.ts:158` (`@platos/core` ApiClient), `trigger.config.ts:23`, `shared/env.ts:133-140`.
- **Crypto:** `monitoring/message-crypto.service.ts` (encrypt-before-send boundary).
- **Baggage:** `internal-packages/{run-engine,run-queue,schedule-engine}`, `packages/{trigger-sdk,core,redis-worker,react-hooks}`, `apps/webapp/app/runEngine/*`, `docker-compose.platos.yml` `worker:`. The unused vendored Trigger CLI was removed in WIN-162.
- **Schema slim:** drop the 68 runtime models; keep `Organization`/`Project`/`RuntimeEnvironment` (+enum).

**Two CLAUDE.md corrections to make alongside:** `enableThreading` is Slack-style message replies, _not_ a per-thread stream multiplex; memory extraction is an hourly cron sweep (`updatedAt`/`turnCount`), _not_ a per-turn post-completion job.
