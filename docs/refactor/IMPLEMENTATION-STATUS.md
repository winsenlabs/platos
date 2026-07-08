# Refactor Implementation Status — `shrink` branch

Tracks the execution of [`platos-trigger-refactor.md`](./platos-trigger-refactor.md) on the `shrink` branch.
**Ground rule (from the spec): no big-bang.** Additive, zero-regression work is auto-implemented and kept typecheck-green. Destructive/irreversible work is **staged for human review**, not blind-executed.

## Status: additive foundation COMPLETE ✅

The zero-regression foundation is landed and typecheck-green on `shrink`: `executionMode` field, the durable trigger tasks (`durable-turn`/`employee-run`/`skill-run`) + their `/internal/*` endpoints, the WS dispatch branch (dormant until managed trigger), and the MCP task/skill write surface (pre-existing). Everything is inert on a deployment without managed trigger — **zero behaviour change today.**

**To activate the durable path (your one action):** create a managed trigger.dev project, put the keys in the app `.env` (see the SECRETS section below), then `npx trigger.dev deploy` the tasks and set an agent's `executionMode="durable"`. The `🔒` destructive shrink (SDK swap, delete run-engine, drop 68 models, webapp retire) is blocked on that project existing and lands as its own reviewed PRs.

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
| `/internal/skill-run` endpoint | ✅ | `agent.controller.ts` (admin-token), runs the skill via `SkillRuntimeService.invokeTool`. skill-run task now functional. |
| Per-token streaming refinement (durable turn → per-token metadata) | ⏳ | Variant-A polish; today durable turns deliver the final result via the run. |
| Platform-MCP write tools | ✅ | **Already existed** — `trigger.tasks.trigger`, `trigger.runs.cancel/replay`, `platos_tasks.create/run/get_runs`, `skills.*` in `mcp-platform/tools/{trigger,platos_tasks,skills}.ts`. Scope-pinned via the MCP token; trigger.* are admin-tier gated. "Create/run tasks via MCP" is a solved surface. |
| Dispatch branch on `executionMode` (WS) | ✅ | `connections.gateway.ts` `tryDispatchDurable()` — triggers `platos.agent.durable-turn` + `RunsBridge.subscribe` when `executionMode="durable"` AND `TRIGGER_SECRET_KEY` set AND threadId present; else falls through to the in-process `direct` path. Dormant/zero-regression until managed trigger exists. Lazy `getRunsBridge()` via `ModuleRef`. |
| Dispatch branch (SSE/REST path in `agent.controller.ts`) | ⏳ | WS path done; SSE mirror is a small follow-up. |
| Per-skill task-offload flag (mid-turn) | 🟡 | The `skill-run` task + `/internal/skill-run` endpoint + `skills_run` MCP surface are all ready. The remaining bit is the mid-turn dispatch flag in `skill-handlers.ts` (heavy skills → `triggerAndWait` the task) — a hot-path change staged for review. |
| Tenant isolation: `concurrencyKey: org-<id>` | ✅ | Stamped on every durable dispatch in `tryDispatchDurable` (Model A). Per-tenant trigger-compute cost metering into the ledger is a follow-up. |

## Done since the foundation
| Item | Status |
|---|---|
| ✅ **SDK swap** — `apps/agent` onto real `@trigger.dev/sdk`+`@trigger.dev/core` **4.5.0** | Done. ~24 import sites swapped; typecheck 0 errors / 6/6. The real 4.5.0 API is fully compatible — agent is OFF the fork SDK. |
| ✅ **Webapp navbar** Platos-only + **~42 trigger routes** removed (459→421) | Navbar stripped; removed deployments/schedules/batches/queues/test/waitpoints/bulk-actions/alerts + AI(prompts/models) + Observability(logs/errors/metrics/dashboards) + the whole **Query feature** (components/services/eval untangled). All verified: webapp typecheck holds at baseline 2 (pre-existing server.ts). |
| 🟡 **Webapp — coupled/decision routes remaining** | `regions/limits/concurrency/branches` (coupled to shared components, need untangle) + the **`runs`** dashboard (52 files + `components/runs`, awaiting the strip-vs-repurpose call). KEEP: run-engine api.v1.*/engine.*, environment-variables (Platos scoped secrets), apikeys, settings.integrations (Platos `.mcp`). |
| ✅ **GitHub Actions auto-deploy** (`.github/workflows/trigger-deploy.yml`) | Written. Needs: `TRIGGER_ACCESS_TOKEN` GitHub secret + `TRIGGER_PROJECT_REF` var (your `proj_…`). |

## Deploy — the one thing left to make it live
- Set `TRIGGER_PROJECT_REF` to your project's `proj_…` (in `trigger.config.ts` or the repo var) — the config still defaults to the old `proj_sourblwsegejrzfjmrug`.
- Add `TRIGGER_ACCESS_TOKEN` (your `tr_pat_…`) as a GitHub Actions secret.
- Then push (or run the workflow) → `trigger.dev deploy` registers the tasks on your project. After that, an agent with `executionMode="durable"` runs on managed trigger.

## Staged for review — destructive, NOT auto-run (needs your go-ahead)
| Item | Why staged |
|---|---|
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
