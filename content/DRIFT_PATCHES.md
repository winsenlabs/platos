# Drift patches log

Append-only log of every drift patch landed during Phase 2 doc body authoring. Source of truth for "what shipped" — `git log --grep "DOCS-DRIFT-"` is the authoritative cross-check.

## Summary

- **PATCHED in code:** 2 (D-003, D-004).
- **PATCHED via docs only:** 4 (D-006, D-007, D-008, D-009, D-010 — also covered inline). These items are absorbed into the doc bodies; the underlying code is left in place because removing it requires changes outside the docs scope (FE refactor, backend route consolidation, workspace re-inclusion).
- **DEFERRED:** 3 (D-001, D-002, D-005). Each carries the same shape: a destructive code change with surface area beyond docs. Documented inline so customers and operators know the current behaviour.

| Drift | Status | Commit | One-line |
|---|---|---|---|
| D-001 | DEFERRED | n/a | `/agent-orgs` 307 shim still active; pathBuilder + SideMenu + 3 routes touch this. |
| D-002 | DEFERRED | n/a | `spawn_task` alias still active; cutover needs release notes. |
| D-003 | PATCHED | `9f940b133` | `PLATOS_STREAM_HEARTBEAT_MS` now reads through validated env; stale TODO removed. |
| D-004 | PATCHED | `6207bac1b` | `cost7dCents: number` lifted into shared `WithCost7d` helper type. |
| D-005 | DEFERRED | n/a | Cluster tab on agent detail page is a UI feature (FE ticket). |
| D-006 | DOCS | n/a | Two-route split called out in `mcp-gateway.md`. |
| D-007 | DOCS | n/a | Docs cite function names + grep hints, not line numbers. |
| D-008 | DOCS | n/a | Same as D-007. |
| D-009 | DOCS | n/a | One user-facing concept; two-controller split called out in `public-agents-and-embed.md`. |
| D-010 | DOCS | n/a | Standalone install path called out in `quickstart.md` + `connect-entity-platools-ts.md`. |

## D-003 — route PLATOS_STREAM_HEARTBEAT_MS through validated env

- Commit: `9f940b133`
- Files: `apps/agent/src/agent-runtime/agent.controller.ts`
- Change: replace two `process.env.PLATOS_STREAM_HEARTBEAT_MS` reads with `env.PLATOS_STREAM_HEARTBEAT_MS`. The env variable was already declared in `apps/agent/src/shared/env.ts`; controller was the holdout. Stale `TODO(env.ts)` comment removed.
- Verification: typecheck_+_grep_verified. Agent app `tsc --noEmit` clean. Grep `process.env.PLATOS_STREAM_HEARTBEAT_MS` returns zero hits in `apps/agent/`.

## D-004 — lift cost7dCents into a shared WithCost7d type

- Commit: `6207bac1b`
- Files: `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-monitoring.users._index/route.tsx`
- Change: introduce `type WithCost7d = { cost7dCents: number }` and intersect into `UserRow`, `AgentRow`, `UserDetail`. The field declaration site is now one row, not three.
- Verification: typecheck_+_grep_verified. Webapp `pnpm run typecheck` reproduces the same two pre-existing `server.ts:240` Socket.IO type errors that existed before this commit (verified by stashing the change and re-running). No new errors introduced.

## Deferred items — rationale

### D-001: `/agent-orgs` shim removal

The shim covers three routes (`agent-orgs._index`, `agent-orgs.$orgId`, `agent-orgs.new`) plus `agentOrgsPath()` in `pathBuilder.ts` plus a SideMenu match regex. Removing requires synchronised changes across all five sites and risks SideMenu highlight regression for users on the new path. Out of scope for the docs phase. Doc inline note in `connected-entities.md` informs users the new path is canonical.

### D-002: `spawn_task` alias removal

The alias is wired into `agent.service.ts` orchestration registration and `agent-crud.service.ts` default-on map. Existing agents have prompts that reference `spawn_task` by name. Removal requires release-notes coordination + a migration helper that rewrites in-flight agent prompts. Out of scope. Doc inline notes in `platos-tasks.md` and `spawn-bgo.md` push customers toward `spawn_bgo`.

### D-005: Cluster tab on agent detail page

A FE feature, not a docs task. The `agent-clusters` doc's Common pitfalls section tells users to bookmark the cluster URL until the tab ships. Track as a follow-up FE ticket.
