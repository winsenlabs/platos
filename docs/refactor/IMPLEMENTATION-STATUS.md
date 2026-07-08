# Refactor Implementation Status — `shrink` branch

Tracks the execution of [`platos-trigger-refactor.md`](./platos-trigger-refactor.md) on the `shrink` branch.
**Ground rule (from the spec): no big-bang.** Additive, zero-regression work is auto-implemented and kept typecheck-green. Destructive/irreversible work is **staged for human review**, not blind-executed.

## Legend
✅ done & typecheck-green · 🟡 in progress · ⏳ queued (additive) · 🔒 staged for review (destructive — NOT auto-run)

## Additive / zero-regression (auto-implemented on `shrink`)
| Item | Status | Notes |
|---|---|---|
| `PlatosAgent.executionMode` field (`"direct"`\|`"durable"`, default `direct`) | ✅ | String field, matches `historyMode`/`toolMode` convention; version snapshot (JSON) captures it. |
| New trigger tasks: `durable-turn`, `employee-run`, `skill-run` | ✅ | Written + registered in `index.ts`, typecheck-green. Thin-shell (variant A): call back to `/internal/*` (added next). Use existing `@platos/sdk` (proven `task()`/`metadata`/`logger`). |
| `approval-waitpoint` task | ✅ | Already exists as `agentDurableApprovalWait` (`wait.forToken`). Wiring `request_approval`→it is a staged agent-code change. |
| `agent-session` (chat.agent / Sessions) | 🔒 | Needs the real `@trigger.dev/sdk` — `chat.agent`/Sessions are not in the vendored fork. Lands with the SDK swap. |
| Callback endpoints `POST /api/v1/agent/internal/{durable-turn,employee-run}` | ✅ | In `agent.controller.ts` (admin-token gated, same pattern as `internal/compaction`), reuse `executeNonStreamingTurn`; scope-guard bypass extended (`scope.guard.ts`). durable-turn + employee-run tasks now functional. |
| `/internal/skill-run` endpoint + per-token streaming refinement | ⏳ | skill-run endpoint lands with the per-skill flag; incremental metadata streaming (variant-A polish) is a follow-up. |
| Platform-MCP write tools: `tasks_trigger`, `trigger_runs_create/cancel`, `skills_run` | ⏳ | Extend `apps/agent/src/mcp-platform/`; enforce `ScopeGuard`, stamp scope from token not payload. |
| Dispatch branch on `executionMode` (WS) | ✅ | `connections.gateway.ts` `tryDispatchDurable()` — triggers `platos.agent.durable-turn` + `RunsBridge.subscribe` when `executionMode="durable"` AND `TRIGGER_SECRET_KEY` set AND threadId present; else falls through to the in-process `direct` path. Dormant/zero-regression until managed trigger exists. Lazy `getRunsBridge()` via `ModuleRef`. |
| Dispatch branch (SSE/REST path in `agent.controller.ts`) | ⏳ | WS path done; SSE mirror is a small follow-up. |
| Per-skill task-offload flag | ⏳ | `skill-handlers.ts`; heavy/parallel/long skills → `skill-run` task. |
| Tenant isolation: `concurrencyKey: org-<id>` + cost metering | ⏳ | On every durable dispatch (Model A). |

## Staged for review — destructive, NOT auto-run (needs your go-ahead)
| Item | Why staged |
|---|---|
| 🔒 Swap `@platos/sdk`/`@platos/core` → real `@trigger.dev/sdk` | Breaks the build until a managed trigger project + keys exist; touches every task + `agent.service.ts:158`. |
| 🔒 Delete `internal-packages/{run-engine,run-queue,schedule-engine}` | `apps/webapp` imports run-engine; deleting breaks webapp typecheck until webapp track (P5) lands. |
| 🔒 Delete `packages/{trigger-sdk,cli-v3,core,redis-worker,react-hooks}` | Same — cascade through webapp + build graph. |
| 🔒 Drop 68 trigger runtime Prisma models | Destructive migration; needs review + data plan (play.platos.dev resettable, real deploys not). |
| 🔒 Retire/repoint `apps/webapp` run-engine role + `worker` compose service | The webapp *is* the forked platform; needs the standalone-console decision (§13). |

**These 🔒 items are the "shrink" itself. They land as their own reviewed PRs once P0 (managed trigger project stood up) is real — because they require the managed substrate to exist first.**

---

## SECRETS — where to add them (app `.env`)

All of the following go in the **application's root `.env`** (the same file `docker-compose.platos.yml` reads and passes to the `agent` service). The agent validates them in `apps/agent/src/shared/env.ts` (all already declared, all optional today).

```bash
# ── Managed trigger.dev (the durable substrate) ─────────────────────
# Create a project at trigger.dev (or your self-hosted instance) and copy:
TRIGGER_API_URL=https://api.trigger.dev          # managed cloud API base (or self-host URL)
TRIGGER_SECRET_KEY=tr_prod_xxxxxxxxxxxxxxxx       # the project's secret key (SDK access + `trigger.dev deploy`)
TRIGGER_PROJECT_REF=proj_xxxxxxxxxxxx             # the project ref (for CLI deploy)

# HMAC secret for trigger tasks calling BACK into Platos (/internal/*).
# Generate once: `openssl rand -hex 32`. Must match on the agent and in the deployed tasks' env.
TRIGGER_INTERNAL_SECRET=<64-hex-chars>

# ── Platform-MCP trigger tools (tasks_trigger / trigger_runs_*) ─────
# Used by apps/agent/src/mcp-platform/tools/trigger.ts (plain fetch against these).
PLATOS_TRIGGER_API_URL=https://api.trigger.dev
PLATOS_TRIGGER_API_KEY=tr_prod_xxxxxxxxxxxxxxxx   # can equal TRIGGER_SECRET_KEY
PLATOS_TRIGGER_PROJECT_REF=proj_xxxxxxxxxxxx

# ── Already required for existing task callbacks (keep as-is) ───────
PLATOS_ADMIN_TOKEN=<shared admin token>           # tasks → agent admin endpoints
```

**Deployment note (for the trigger-driven deploy you mentioned):** the trigger tasks are deployed with `npx trigger.dev deploy` (from `apps/agent`, which already has `trigger.config.ts` with `dirs: ["./src/trigger-tasks"]`). That deploy needs `TRIGGER_SECRET_KEY` + `TRIGGER_PROJECT_REF` in the environment. Once the managed project exists and these secrets are set, the deploy step can be wired to a trigger/CI job.

**Model A (multi-tenant) reminder:** one shared Platos trigger project; tenants are isolated by `concurrencyKey: org-<id>` + per-tenant budget caps + cost metering — no per-tenant secrets needed. Per-tenant "BYO-trigger" (Model B) stores the tenant's own `TRIGGER_*` encrypted per-scope in the SecretStore (BYOK path), not in `.env`.
