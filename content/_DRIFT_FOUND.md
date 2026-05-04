# FE/BE drift backlog (Phase 1 walkthrough)

Drift items spotted while walking the codebase to map docs to source files. None of these are patched in Phase 1, only surfaced. Phase 2 owners are listed per item; the relevant doc-writing pass should fix the underlying issue alongside the doc body and commit it as `DOCS-DRIFT-NNN: <one-line>`.

Severity legend:

- **high** — user-visible bug, missing data on UI, or potential cross-tenant leak.
- **medium** — confusing dev experience, deprecated path still active, drift in API surface that customers may rely on.
- **low** — naming inconsistency, stale comment, doc-only mismatch.

---

## D-001 — `/agent-orgs` route still active as a 307 shim

- **Backend:** `apps/agent/src/agent-runtime/agent.controller.ts` exposes `/agent-entities/*` as the canonical entity surface. Schema model name is still `PlatosConnectedEntity`.
- **Frontend:** `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-orgs._index/route.tsx:18` 307-redirects to `/agent-entities/`. Comment at `:1-9` says "Delete after the next release."
- **Severity:** low. The shim works; it just keeps a deprecated path live longer than its one-release deadline.
- **Phase 2 owner:** the `connected-entities` doc.
- **Status:** **DEFERRED**. Removal touches `agentOrgsPath()` in `apps/webapp/app/utils/pathBuilder.ts`, the SideMenu's `/(agents|agent-tools|agent-orgs|agent-providers|...)` regex, plus three route folders. Out of scope for the docs phase; surface-area for collateral breakage is real (SideMenu highlight regression, external bookmarks). Documented inline in `content/docs/connected-entities.md`.

## D-002 — `spawn_task` meta-tool kept as a deprecated alias past its promised one-release window

- **Backend:** `apps/agent/src/agent-runtime/agent.service.ts:651-652` still registers `spawn_bgo` and `spawn_task` as orchestration tools. `apps/agent/src/agent-runtime/agent-crud.service.ts:482-483` still defaults both on for new agents.
- **CLAUDE.md** (`§1`): "Same for `list_bgos` (was `list_tasks`) and `schedule_bgo` (was `trigger_with_delay`). The engine keeps task forever; Platos uses bgo on every surface an agent or customer sees... kept as a deprecated alias for one release."
- **Severity:** low. Still functional; just outlives the one-release promise from the rename PRD. Customers using `spawn_task` in tool prompts will keep working.
- **Phase 2 owner:** the `platos-tasks` doc.
- **Status:** **DEFERRED**. Removing the alias is a destructive change for any agent prompt that references `spawn_task` by name. Needs a coordinated cutover (release notes, migration helper) outside the docs phase. Documented inline in `content/docs/platos-tasks.md` and `content/guides/spawn-bgo.md` so customers know to migrate.

## D-003 — TODO marker in agent.controller.ts about an unmigrated env var

- **Backend:** `apps/agent/src/agent-runtime/agent.controller.ts:640` has `// TODO(env.ts) add to AgentEnvSchema`. The env value is read inline without going through the typed env schema.
- **Severity:** medium. Means the value is not validated at boot; misconfiguration shows up as a runtime undefined.
- **Phase 2 owner:** the `self-hosting` doc when the config table gets generated.
- **Status:** **PATCHED in commit `9f940b133`**. `PLATOS_STREAM_HEARTBEAT_MS` was already declared in `apps/agent/src/shared/env.ts` (added during EOBD-89/106) but the controller still read `process.env.X` inline. Both call sites now route through the typed `env.PLATOS_STREAM_HEARTBEAT_MS` accessor. Stale TODO comment removed.

## D-004 — agent-monitoring users page exposes `cost7dCents` shape consistently — but two interfaces declare the same field three times

- **Frontend:** `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-monitoring.users._index/route.tsx:57, 76, 96` all declare `cost7dCents: number` on three different interfaces (UserSummary, AgentSummary, UserDetail) without a shared type.
- **Severity:** low. Not a bug, but a maintenance trap: a future rename would have to touch all three. No action required for docs phase, surfacing for the body-writing pass to consider linking a single shared type.
- **Phase 2 owner:** the `monitoring` doc.
- **Status:** **PATCHED in commit `6207bac1b`**. Introduces a `WithCost7d` helper type intersected into all three row types. No runtime change; one source for the field.

## D-005 — `agent-cluster.service.ts` ships but no top-level sidebar entry on `agents.$agentId._index`

- **Backend:** `apps/agent/src/agent-runtime/agent-cluster.service.ts` plus routes at `agent-clusters._index` and `agent-clusters.$clusterId`.
- **Frontend:** the agent detail tabs at `agents.$agentId._index/route.tsx` do not mention clusters; only the sidebar at `agent-clusters._index` exposes them. A user on the agent detail page has no nav cue that clusters exist or that this agent belongs to one.
- **Severity:** medium. Hides a shipped feature.
- **Phase 2 owner:** the `agent-clusters` doc.
- **Status:** **DEFERRED**. Adding a Cluster tab to the agent detail page is a UI feature, not a docs task. Documented inline in `content/docs/agent-clusters.md` so users know how to reach the cluster surface from the top-level sidebar today. Track as a follow-up FE ticket.

## D-006 — Settings: two separate "integrations" routes (project-scoped vs org-scoped) with confusingly similar titles

- **Frontend:** `_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.integrations._index` is the project-scoped page. `_app.orgs.$organizationSlug.settings.integrations.slack.tsx` is the org-scoped Slack page. Same nav label but different scopes.
- **Severity:** low. Confusing for the docs writer to disambiguate. The docs themselves should be split across the `mcp-gateway` doc (org-scoped MCP tokens) vs the `webhooks` doc (project Slack alerts).
- **Phase 2 owner:** the `mcp-gateway` and `webhooks` doc writers should reference each other.
- **Status:** **PATCHED via docs only**. `content/docs/mcp-gateway.md` Common pitfalls section calls out the two-route split with disambiguation. Renaming the FE routes is out of scope.

## D-007 — `apps/agent/src/agent-runtime/agent.controller.ts` is 4,817 lines

- **Backend:** A single file holds entity CRUD, agent CRUD, monitoring endpoints, embed token endpoints, public guest endpoints, share endpoints. Many docs will reference this file as their "see source" pointer; the file:line citations from Phase 2 will rot fast as this file changes.
- **Severity:** medium. Affects the durability of doc citations, not correctness.
- **Phase 2 owner:** any doc referencing this file should pin to a function name + grep hint, not a line number.
- **Status:** **HONOURED in docs**. Bodies in `content/docs/*.md` reference function names and feature areas (`tool-sync-ws.service.ts:130-135, 281-284` is the one durable file:line citation, called out as a load-bearing invariant). Splitting the controller is a backend refactor; out of scope.

## D-008 — `agent-runtime/agent.service.ts` is 6,148 lines

- **Backend:** Same problem, larger file. Holds the turn loop, prompt builder calls, tool-call wiring, cost accounting, token-counting, and meta-tool registration.
- **Severity:** medium. Same line-number rot risk as D-007.
- **Phase 2 owner:** any doc referencing this file uses function names, not line numbers.
- **Status:** **HONOURED in docs**. Same treatment as D-007 — docs reference behaviours and function names, not line numbers in this file.

## D-009 — Public guest token controller lives under `auth/` but the route is under the agent runtime nav

- **Backend:** `apps/agent/src/auth/public-guest-token.controller.ts` ships the public guest mint endpoint. `apps/agent/src/agent-runtime/agent.controller.ts` ships the share-token endpoint. Both feed the same UX surface (`agents.$agentId.share`).
- **Severity:** low. Two endpoints serving one feature. Docs should describe the single user-facing concept ("share an agent publicly") and let the source files line up below.
- **Phase 2 owner:** the `public-agents-and-embed` doc.
- **Status:** **PATCHED via docs only**. `content/docs/public-agents-and-embed.md` describes the single user-facing concept and notes the two-controller split for low-level integrators. Refactor to consolidate is a follow-up backend ticket.

## D-010 — `references/` was dropped from the workspace in Theme R.4 but `references/entity-hello-world/` is referenced by PPR-49 onboarding docs

- **Codebase:** `pnpm-workspace.yaml` no longer includes `references/*`. PPR notes (CLAUDE.md §13) describe `references/entity-hello-world/` as the canonical reference entity backend.
- **Severity:** medium. The OSS quickstart guide will want to point new users at this folder; if it's outside the workspace, the install steps need an explicit "this is a standalone example, install with its own package.json" note.
- **Phase 2 owner:** the `quickstart` and `connect-entity-platools-ts` guides.
- **Status:** **PATCHED via docs only**. `content/guides/quickstart.md` and `content/guides/connect-entity-platools-ts.md` both call out the standalone-install path. Re-adding `references/*` to the workspace would put OSS reference code into the build closure; out of scope.
